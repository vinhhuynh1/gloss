"""
The agent: given a passage of the shared notes, retrieves the most relevant
source chunks and asks the LLM to check the passage against them.

In the app this runs inside worker.py, which claims "check this passage"
requests the editor queues (see infra/migrations/004_agent_requests.sql) and
writes the result as a suggestion. The CLI below runs one pass by hand and
posts the result through the API:

    python agent.py <document_id> <study_space_id> "<notes passage text>"

A suggestion made from the CLI has no position in the document — only the
editor can compute one — so it shows in the sidebar without a highlight and
can only be dismissed.
"""
import json
import os
import sys
from pathlib import Path

import anthropic
import requests
from dotenv import load_dotenv

from prompts import AGENT_SYSTEM_PROMPT, build_agent_prompt
from retrieval import search

# Anchored to this file rather than the CWD — eval/run_eval.py imports this
# module while running out of eval/, where a bare load_dotenv() finds no
# .env at all and ANTHROPIC_API_KEY would never be loaded.
load_dotenv(Path(__file__).with_name(".env"))

API_BASE_URL = os.getenv("API_BASE_URL", "http://localhost:8000")
# Used only by the CLI path, which writes through the API. The worker writes
# suggestions straight to the database and does not need it. Must match
# AGENT_SERVICE_TOKEN in apps/api/.env.
AGENT_SERVICE_TOKEN = os.getenv("AGENT_SERVICE_TOKEN", "")
# If this model name is rejected, check the current list at
# https://docs.claude.com/en/docs/about-claude/models and update it here.
ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL", "claude-opus-5")

TOP_K = 5
VALID_TYPES = ("citation", "contradiction", "gap_fill", "none")

# Not a tight cap on purpose. Thinking is on by default for this model and its
# tokens count against max_tokens, so the old 1024 could be spent entirely on
# thinking and end the response with no text block at all — which surfaced as
# a crash in _response_text, not as a verdict.
MAX_TOKENS = 16000

# Structured output: the API guarantees the text block is JSON matching this,
# so there is no fence-stripping or parse-and-hope. It cannot guarantee the
# cited chunk id was one we actually retrieved — _validate still checks that.
VERDICT_SCHEMA = {
    "type": "object",
    "properties": {
        "type": {"type": "string", "enum": list(VALID_TYPES)},
        "proposed_text": {"type": "string"},
        "source_chunk_id": {"anyOf": [{"type": "string"}, {"type": "null"}]},
        "reasoning": {"type": "string"},
    },
    "required": ["type", "proposed_text", "source_chunk_id", "reasoning"],
    "additionalProperties": False,
}

_client: anthropic.Anthropic | None = None


def _get_client() -> anthropic.Anthropic:
    """One client per process, created on first use so importing this module
    (eval/run_eval.py does) never requires a key it will not use."""
    global _client
    if _client is None:
        _client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from the environment
    return _client


def retrieve_chunks(study_space_id: str, notes_passage: str) -> list[dict]:
    """Top-K most semantically similar chunks, scoped to this study space so
    one course's material can never leak into another course's answers.

    Thin wrapper over retrieval.search() rather than its own query: search.py
    exists to tell you whether retrieval is working, and it can only do that
    honestly if it runs the identical query. Kept as a named function here
    because eval/run_eval.py imports it from this module."""
    return search(study_space_id, notes_passage, TOP_K)


def _none(reasoning: str) -> dict:
    return {"type": "none", "proposed_text": "", "source_chunk_id": None,
            "reasoning": reasoning}


def call_llm(notes_passage: str, chunks: list[dict]) -> dict:
    response = _get_client().beta.messages.create(
        model=ANTHROPIC_MODEL,
        max_tokens=MAX_TOKENS,
        system=AGENT_SYSTEM_PROMPT,
        messages=[
            {"role": "user", "content": build_agent_prompt(notes_passage, chunks)}
        ],
        output_config={"format": {"type": "json_schema", "schema": VERDICT_SCHEMA}},
        # A policy decline is re-run server-side on Anthropic's recommended
        # fallback model instead of coming back as a refusal. Course notes
        # should essentially never trip this, but a biology or security course
        # can, and without it the pass would just end with no verdict.
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
    )

    # Checked before reading content: a refusal can carry no text block, and
    # "the model would not answer" is a 'none', not a crash.
    if response.stop_reason == "refusal":
        return _none("model declined to answer")
    if response.stop_reason == "max_tokens":
        raise RuntimeError(f"Response hit max_tokens ({MAX_TOKENS}) before finishing")

    text = next((b.text for b in response.content if b.type == "text"), None)
    if text is None:
        raise ValueError(
            f"No text block in response (stop_reason={response.stop_reason!r})"
        )
    return _validate(json.loads(text), chunks)


def _validate(result: dict, chunks: list[dict]) -> dict:
    """Guard against the two failure modes that matter most here: an invalid
    suggestion type, and a citation pointing at a chunk that was never
    retrieved (i.e. an invented source). Both downgrade to 'none' rather
    than reaching the user — a tool people trust to check their notes must
    not itself assert things it can't back up.

    The schema makes the first unreachable in practice; it stays because it
    costs nothing and eval runs against older recorded outputs would need it."""
    if result.get("type") not in VALID_TYPES:
        return _none(f"invalid type from model: {result.get('type')!r}")

    chunk_id = result.get("source_chunk_id")
    if chunk_id and chunk_id not in {c["id"] for c in chunks}:
        return _none(f"model cited a chunk that was not retrieved: {chunk_id!r}")

    # Every suggestion type is a claim about the source, so one that names no
    # excerpt is ungrounded by definition — and an accepted citation is built
    # from the cited chunk, so it would have nothing to say.
    if result["type"] != "none" and not chunk_id:
        return _none(f"model made a {result['type']} suggestion without citing an excerpt")

    return result


def check_passage(study_space_id: str, notes_passage: str) -> tuple[dict | None, list[dict]]:
    """Retrieve, then ask. Returns (verdict, chunks).

    verdict is None when the space has no searchable material at all — there
    is nothing to ground a suggestion in, and asking the model anyway would
    only invite it to answer from outside knowledge."""
    chunks = retrieve_chunks(study_space_id, notes_passage)
    if not chunks:
        return None, []
    return call_llm(notes_passage, chunks), chunks


def cited_chunk(result: dict, chunks: list[dict]) -> dict | None:
    """The retrieved chunk the verdict grounds itself in, if any."""
    chunk_id = result.get("source_chunk_id")
    return next((c for c in chunks if c["id"] == chunk_id), None)


def run_agent_pass(document_id: str, study_space_id: str, notes_passage: str):
    result, chunks = check_passage(study_space_id, notes_passage)
    if result is None:
        print("No source material found for this study space — ingest a PDF first.")
        return None

    print(f"Verdict: {result['type']} — {result.get('reasoning', '')}")
    if result["type"] == "none":
        return None

    chunk = cited_chunk(result, chunks)
    response = requests.post(
        f"{API_BASE_URL}/suggestions",
        json={
            "document_id": document_id,
            "type": result["type"],
            # No position: the CLI has no view of the Yjs document. The editor
            # treats an anchor without from/to as unanchored.
            "anchor": {"source": "cli", "quote": notes_passage},
            "proposed_text": result["proposed_text"],
            "source_chunk_id": result.get("source_chunk_id"),
            "source_filename": chunk["filename"] if chunk else None,
            "source_page_ref": chunk["page_ref"] if chunk else None,
            "source_excerpt": chunk["text"] if chunk else None,
        },
        headers={"X-Agent-Token": AGENT_SERVICE_TOKEN},
        timeout=30,
    )
    response.raise_for_status()
    print("Suggestion created.")
    return response.json()


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print(__doc__)
        sys.exit(1)
    run_agent_pass(sys.argv[1], sys.argv[2], sys.argv[3])
