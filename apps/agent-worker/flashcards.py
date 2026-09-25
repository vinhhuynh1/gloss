"""
Generating a flashcard deck from a whole notes document.

A sibling of study_guide.py, and deliberately thin: the two differ in their
prompt and their output shape, and in nothing else. Sectioning, retrieval and
the refusal to pass on anything ungrounded are imported from there rather than
copied, so a fix to retrieval reaches both.

The one thing worth restating is why retrieval is per section. A query
embedding is one vector: hand it the whole document and it lands between every
topic in it, matching everything a little and nothing well. See the longer
note at the top of study_guide.py.
"""
import json

from agent import ANTHROPIC_MODEL, MAX_TOKENS, _get_client
from prompts import FLASHCARDS_SYSTEM_PROMPT, build_flashcards_prompt
from study_guide import EmptyNotesError, retrieve_for_notes, split_sections

# A deck longer than this is not a deck, it is a transcript. The model is
# asked for one to three cards per idea; this is the backstop for a document
# that manages to be both long and repetitive.
MAX_CARDS = 60

CARDS_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "cards": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "front": {"type": "string"},
                    "back": {"type": "string"},
                    "source_chunk_id": {"type": "string"},
                },
                "required": ["front", "back", "source_chunk_id"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["title", "cards"],
    "additionalProperties": False,
}


def _validate_deck(result: dict, chunks: list[dict]) -> dict:
    """Drop every card the model could not ground.

    Same rule as _validate_guide, and the same reasoning: a card citing a
    chunk that was never retrieved is an invented source, and an invented
    source on a flashcard is worse than on a guide point — the reader is
    testing themselves against it and has no prose around it to notice the
    claim is unsupported. A thinner deck is the honest outcome.

    Citation metadata is denormalized onto each card so it still says where
    the answer came from after the next re-chunk.
    """
    by_id = {c["id"]: c for c in chunks}

    cards = []
    for card in result.get("cards", []):
        chunk = by_id.get(card.get("source_chunk_id"))
        if chunk is None:
            continue
        front = (card.get("front") or "").strip()
        back = (card.get("back") or "").strip()
        # A card missing either half cannot be reviewed, and an empty back is
        # the shape a truncated response leaves behind.
        if not front or not back:
            continue
        cards.append(
            {
                **card,
                "front": front,
                "back": back,
                "source_filename": chunk["filename"],
                "source_page_ref": chunk["page_ref"],
                "source_excerpt": chunk["text"],
            }
        )

    return {
        "title": result.get("title") or "Flashcards",
        "cards": cards[:MAX_CARDS],
    }


def call_llm(notes: str, chunks: list[dict]) -> dict:
    response = _get_client().beta.messages.create(
        model=ANTHROPIC_MODEL,
        max_tokens=MAX_TOKENS,
        system=FLASHCARDS_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": build_flashcards_prompt(notes, chunks)}],
        output_config={"format": {"type": "json_schema", "schema": CARDS_SCHEMA}},
        # Same reasoning as study_guide.call_llm: a policy decline is re-run on
        # the recommended fallback rather than coming back as a refusal.
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
    )

    if response.stop_reason == "refusal":
        raise RuntimeError("Model declined to write flashcards for these notes")
    if response.stop_reason == "max_tokens":
        raise RuntimeError(f"Response hit max_tokens ({MAX_TOKENS}) before finishing")

    text = next((b.text for b in response.content if b.type == "text"), None)
    if text is None:
        raise ValueError(
            f"No text block in response (stop_reason={response.stop_reason!r})"
        )
    return _validate_deck(json.loads(text), chunks)


def generate(study_space_id: str, notes: str) -> tuple[dict, list[dict]]:
    """One deck. Returns it with the chunks it was given, so a caller that
    wants to score the grounding can see both — same signature as
    study_guide.generate."""
    sections = split_sections(notes)
    if not sections:
        raise EmptyNotesError("There are no notes in this document yet.")

    chunks = retrieve_for_notes(study_space_id, sections)
    if not chunks:
        raise EmptyNotesError(
            "No source material has been ingested for this study space yet, "
            "so there is nothing to ground flashcards in."
        )

    return call_llm(notes, chunks), chunks
