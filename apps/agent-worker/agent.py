"""
The agent: given a passage of the shared notes, retrieves the most relevant
source chunks and asks the LLM to check the passage against them, writing a
suggestion back through the API if it finds something worth flagging.

Usage:
    python agent.py <document_id> <study_space_id> "<notes passage text>"

In the MVP this runs on demand (triggered by an "@ai" mention from the
frontend). The "background agent on a debounce" stretch goal just means
calling this on a timer instead of a manual trigger.
"""
import json
import os
import sys
from pathlib import Path

import anthropic
import psycopg
import requests
from dotenv import load_dotenv

from embeddings import embed
from prompts import AGENT_SYSTEM_PROMPT, build_agent_prompt

# Anchored to this file rather than the CWD — eval/run_eval.py imports this
# module while running out of eval/, where a bare load_dotenv() finds no
# .env at all and ANTHROPIC_API_KEY would never be loaded.
load_dotenv(Path(__file__).with_name(".env"))

DATABASE_URL = os.getenv(
    "DATABASE_URL", "postgresql://study_notes:study_notes@localhost:5432/study_notes"
)
API_BASE_URL = os.getenv("API_BASE_URL", "http://localhost:8000")
# If this model name is rejected, check the current list at
# https://docs.claude.com/en/docs/about-claude/models and update it here.
ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL", "claude-opus-5")

TOP_K = 5
VALID_TYPES = {"citation", "contradiction", "gap_fill", "none"}


def retrieve_chunks(study_space_id: str, notes_passage: str) -> list[dict]:
    """Top-K most semantically similar chunks, scoped to this study space so
    one course's material can never leak into another course's answers."""
    query_embedding = embed(notes_passage)
    with psycopg.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT sc.id, sc.text, sc.page_ref
                FROM source_chunks sc
                JOIN sources s ON s.id = sc.source_id
                WHERE s.study_space_id = %s
                ORDER BY sc.embedding <=> %s::vector
                LIMIT %s
                """,
                (study_space_id, str(query_embedding), TOP_K),
            )
            rows = cur.fetchall()
    return [{"id": str(r[0]), "text": r[1], "page_ref": r[2]} for r in rows]


def _response_text(response) -> str:
    """The first text block of a response.

    Not the same as content[0]: on current models thinking is on by default,
    so content[0] is usually a thinking block and indexing it blindly raises
    AttributeError."""
    for block in response.content:
        if block.type == "text":
            return block.text
    raise ValueError(
        f"No text block in response (stop_reason={response.stop_reason!r})"
    )


def _extract_json(raw: str) -> dict:
    """Models often wrap JSON in ``` fences despite being told not to.
    Strip them rather than letting a well-formed answer fail to parse."""
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text
        text = text.rsplit("```", 1)[0]
    return json.loads(text.strip())


def call_llm(notes_passage: str, chunks: list[dict]) -> dict:
    client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from the environment
    response = client.messages.create(
        model=ANTHROPIC_MODEL,
        max_tokens=1024,
        system=AGENT_SYSTEM_PROMPT,
        messages=[
            {"role": "user", "content": build_agent_prompt(notes_passage, chunks)}
        ],
    )
    result = _extract_json(_response_text(response))
    return _validate(result, chunks)


def _validate(result: dict, chunks: list[dict]) -> dict:
    """Guard against the two failure modes that matter most here: an invalid
    suggestion type, and a citation pointing at a chunk that was never
    retrieved (i.e. an invented source). Both downgrade to 'none' rather
    than reaching the user — a tool people trust to check their notes must
    not itself assert things it can't back up."""
    if result.get("type") not in VALID_TYPES:
        return {"type": "none", "proposed_text": "", "source_chunk_id": None,
                "reasoning": f"invalid type from model: {result.get('type')!r}"}

    chunk_id = result.get("source_chunk_id")
    if chunk_id and chunk_id not in {c["id"] for c in chunks}:
        return {"type": "none", "proposed_text": "", "source_chunk_id": None,
                "reasoning": f"model cited a chunk that was not retrieved: {chunk_id!r}"}

    return result


def yjs_relative_position_for(notes_passage: str) -> dict:
    """
    TODO: the real anchor is computed client-side (the frontend knows the
    Yjs document and can produce a proper relative position for the exact
    span being checked) and passed in here rather than invented server-side.
    This placeholder keeps the pipeline runnable end to end until the
    frontend trigger exists.
    """
    return {"placeholder": True, "passage_preview": notes_passage[:60]}


def run_agent_pass(document_id: str, study_space_id: str, notes_passage: str):
    chunks = retrieve_chunks(study_space_id, notes_passage)
    if not chunks:
        print("No source material found for this study space — ingest a PDF first.")
        return None

    result = call_llm(notes_passage, chunks)
    print(f"Verdict: {result['type']} — {result.get('reasoning', '')}")

    if result["type"] == "none":
        return None

    response = requests.post(
        f"{API_BASE_URL}/suggestions",
        json={
            "document_id": document_id,
            "type": result["type"],
            "anchor": yjs_relative_position_for(notes_passage),
            "proposed_text": result["proposed_text"],
            "source_chunk_id": result.get("source_chunk_id"),
        },
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
