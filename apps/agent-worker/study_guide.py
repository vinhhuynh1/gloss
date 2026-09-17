"""
Generating a revision guide from a whole notes document.

Kept out of agent.py, which is about one passage and one verdict. The shape
is the same underneath — retrieve, ask the model, refuse to pass on anything
it could not ground — but the unit of work is the document, and that changes
how retrieval has to be done.

Retrieval runs per section, not once for the whole document. A query embedding
is one vector: hand it 8,000 characters covering six topics and it lands
somewhere between all of them, matching everything a little and nothing well.
That is the same reasoning behind MAX_PASSAGE_CHARS in apps/api/schemas.py.
Sectioning the notes first and retrieving per section costs N cheap local
embeddings and gets material that is actually about each part.
"""
import json
import re

from agent import (
    ANTHROPIC_MODEL,
    MAX_TOKENS,
    TOP_K,
    _get_client,
    retrieve_chunks,
)
from prompts import STUDY_GUIDE_SYSTEM_PROMPT, build_study_guide_prompt

# Sections shorter than this are headings, stray list items, or the blank line
# someone left mid-thought. They are folded into the section that follows
# rather than spending a retrieval on them.
MIN_SECTION_CHARS = 120

# A ceiling on retrievals per guide, so a very long document cannot turn one
# click into a hundred embeddings and a prompt no context window will hold.
# Sections past this are still sent to the model as notes; they just do not
# get their own retrieval.
MAX_RETRIEVED_SECTIONS = 24

# The model is told to ground every point, and _validate_guide drops the ones
# it did not. This is the ceiling on how many excerpts it has to choose from.
MAX_CHUNKS = MAX_RETRIEVED_SECTIONS * TOP_K

GUIDE_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "sections": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "heading": {"type": "string"},
                    "points": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "text": {"type": "string"},
                                "source_chunk_id": {"type": "string"},
                            },
                            "required": ["text", "source_chunk_id"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": ["heading", "points"],
                "additionalProperties": False,
            },
        },
        "key_terms": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "term": {"type": "string"},
                    "definition": {"type": "string"},
                    "source_chunk_id": {"type": "string"},
                },
                "required": ["term", "definition", "source_chunk_id"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["title", "sections", "key_terms"],
    "additionalProperties": False,
}


class EmptyNotesError(ValueError):
    """The document had nothing in it worth writing a guide from."""


def split_sections(notes: str) -> list[str]:
    """Break the notes into retrieval-sized pieces.

    The editor sends block-separated text (textBetween with "\\n\\n"), so
    blank lines are the block boundaries rather than a guess about prose.
    Short blocks are joined forward because a heading on its own line is a
    terrible retrieval query but a good prefix for the paragraph under it.
    """
    blocks = [b.strip() for b in re.split(r"\n\s*\n", notes) if b.strip()]

    sections: list[str] = []
    carry = ""
    for block in blocks:
        candidate = f"{carry}\n{block}".strip() if carry else block
        if len(candidate) < MIN_SECTION_CHARS:
            carry = candidate
            continue
        sections.append(candidate)
        carry = ""

    # Whatever is left is shorter than the minimum. Append it to the last
    # section rather than dropping it — it is still the group's notes.
    if carry:
        if sections:
            sections[-1] = f"{sections[-1]}\n{carry}"
        else:
            sections.append(carry)
    return sections


def retrieve_for_notes(study_space_id: str, sections: list[str]) -> list[dict]:
    """Union of the per-section retrievals, deduped by chunk id.

    Order is by best score across the sections that matched a chunk, so if the
    prompt has to be trimmed the excerpts that survive are the strongest ones.
    """
    best: dict[str, dict] = {}
    for section in sections[:MAX_RETRIEVED_SECTIONS]:
        for chunk in retrieve_chunks(study_space_id, section):
            seen = best.get(chunk["id"])
            if seen is None or chunk["score"] > seen["score"]:
                best[chunk["id"]] = chunk
    ranked = sorted(best.values(), key=lambda c: c["score"], reverse=True)
    return ranked[:MAX_CHUNKS]


def _validate_guide(result: dict, chunks: list[dict]) -> dict:
    """Drop anything the model could not ground.

    Same rule as agent._validate, applied per item instead of to one verdict:
    a point citing a chunk that was never retrieved is an invented source, and
    an invented source in a revision guide is the failure this whole project
    exists to avoid — it looks checked. Dropping the point leaves a thinner
    guide, which is the honest outcome.

    Returns the guide with citation metadata denormalized onto every item, so
    it still says where each line came from after the next re-chunk.
    """
    by_id = {c["id"]: c for c in chunks}

    def cite(item: dict) -> dict | None:
        chunk = by_id.get(item.get("source_chunk_id"))
        if chunk is None:
            return None
        return {
            **item,
            "source_filename": chunk["filename"],
            "source_page_ref": chunk["page_ref"],
            "source_excerpt": chunk["text"],
        }

    sections = []
    for section in result.get("sections", []):
        points = [p for p in (cite(p) for p in section.get("points", [])) if p]
        # A section whose every point was invented has nothing left to say.
        if points:
            sections.append({**section, "points": points})

    terms = [t for t in (cite(t) for t in result.get("key_terms", [])) if t]

    return {
        "title": result.get("title") or "Study guide",
        "sections": sections,
        "key_terms": terms,
    }


def call_llm(notes: str, chunks: list[dict]) -> dict:
    response = _get_client().beta.messages.create(
        model=ANTHROPIC_MODEL,
        max_tokens=MAX_TOKENS,
        system=STUDY_GUIDE_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": build_study_guide_prompt(notes, chunks)}],
        output_config={"format": {"type": "json_schema", "schema": GUIDE_SCHEMA}},
        # Same reasoning as agent.call_llm: a policy decline is re-run on the
        # recommended fallback rather than coming back as a refusal. Course
        # notes rarely trip this, but a biology or security course can.
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
    )

    if response.stop_reason == "refusal":
        raise RuntimeError("Model declined to write a guide for these notes")
    if response.stop_reason == "max_tokens":
        raise RuntimeError(f"Response hit max_tokens ({MAX_TOKENS}) before finishing")

    text = next((b.text for b in response.content if b.type == "text"), None)
    if text is None:
        raise ValueError(
            f"No text block in response (stop_reason={response.stop_reason!r})"
        )
    return _validate_guide(json.loads(text), chunks)


def generate(study_space_id: str, notes: str) -> tuple[dict, list[dict]]:
    """One guide. Returns it with the chunks it was given, so callers that
    want to score the grounding (eval/run_eval.py) can see both."""
    sections = split_sections(notes)
    if not sections:
        raise EmptyNotesError("There are no notes in this document yet.")

    chunks = retrieve_for_notes(study_space_id, sections)
    if not chunks:
        raise EmptyNotesError(
            "No source material has been ingested for this study space yet, "
            "so there is nothing to ground a guide in."
        )

    return call_llm(notes, chunks), chunks
