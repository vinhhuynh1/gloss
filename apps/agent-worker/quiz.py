"""
Generating a multiple-choice quiz from a whole notes document.

A sibling of study_guide.py, and deliberately thin: sectioning, retrieval and
the refusal to pass on anything ungrounded are imported from there rather than
copied, so a fix to retrieval reaches both. What is particular to a quiz is the
shape of a question and the shuffle after validation.

Why retrieval is per section: a query embedding is one vector, and handed the
whole document it lands between every topic in it, matching everything a
little and nothing well. See the longer note at the top of study_guide.py.
"""
import json
import random

import progress
from agent import MAX_TOKENS
from prompts import QUIZ_SYSTEM_PROMPT, build_quiz_prompt
from study_guide import EmptyNotesError, retrieve_for_notes, split_sections

# Past this a quiz stops being something you sit down and take. The model is
# asked for about one question per key idea; this is the backstop for a long
# document.
MAX_QUESTIONS = 25

# Exactly four, always. A question with three options is easier than its
# neighbours for no reason the reader can see, and the view lays out four.
OPTION_COUNT = 4

# No minItems/maxItems on options: structured outputs do not enforce array
# bounds beyond 0 and 1, so the count is checked in _validate_quiz instead.
QUIZ_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "questions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "question": {"type": "string"},
                    "options": {"type": "array", "items": {"type": "string"}},
                    "correct_index": {"type": "integer"},
                    "explanation": {"type": "string"},
                    "source_chunk_id": {"type": "string"},
                },
                "required": [
                    "question",
                    "options",
                    "correct_index",
                    "explanation",
                    "source_chunk_id",
                ],
                "additionalProperties": False,
            },
        },
    },
    "required": ["title", "questions"],
    "additionalProperties": False,
}


def _clean_options(raw) -> list[str] | None:
    """Four distinct, non-empty strings, or None.

    Distinct after stripping and casefolding: "ATP" and " atp" are the same
    answer to a reader, and a question offering it twice either has two right
    answers or a giveaway.
    """
    if not isinstance(raw, list) or len(raw) != OPTION_COUNT:
        return None
    if not all(isinstance(o, str) for o in raw):
        return None
    options = [o.strip() for o in raw]
    if any(not o for o in options):
        return None
    if len({o.casefold() for o in options}) != OPTION_COUNT:
        return None
    return options


def _valid_index(value) -> bool:
    # bool is a subclass of int, and True would otherwise pass as option 1.
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and 0 <= value < OPTION_COUNT
    )


def _validate_quiz(result: dict, chunks: list[dict]) -> dict:
    """Drop every question the model could not ground or did not finish.

    Same rule as _validate_guide: a question citing a chunk that was never
    retrieved is an invented source, and a wrong citation is worse than a
    missing question because it looks checked. A shorter quiz is the honest
    outcome.

    Citation metadata is denormalized onto each question so it still says
    where the answer came from after the next re-chunk.
    """
    by_id = {c["id"]: c for c in chunks}

    questions = []
    for item in result.get("questions", []):
        chunk = by_id.get(item.get("source_chunk_id"))
        if chunk is None:
            continue
        question = (item.get("question") or "").strip()
        explanation = (item.get("explanation") or "").strip()
        options = _clean_options(item.get("options"))
        correct_index = item.get("correct_index")
        if not question or not explanation or options is None:
            continue
        if not _valid_index(correct_index):
            continue
        questions.append(
            {
                "question": question,
                "options": options,
                "correct_index": correct_index,
                "explanation": explanation,
                "source_chunk_id": chunk["id"],
                "source_filename": chunk["filename"],
                "source_page_ref": chunk["page_ref"],
                "source_excerpt": chunk["text"],
            }
        )

    return {
        "title": (result.get("title") or "").strip() or "Quiz",
        "questions": questions[:MAX_QUESTIONS],
    }


def _shuffle_options(question: dict, rng: random.Random) -> dict:
    """The same question with its options in a random order.

    Models put the right answer in the same slot far more often than chance,
    and students learn the slot faster than the material. Returns a new dict;
    the input is left as it was.
    """
    order = list(range(OPTION_COUNT))
    rng.shuffle(order)
    return {
        **question,
        "options": [question["options"][i] for i in order],
        "correct_index": order.index(question["correct_index"]),
    }


def call_llm(
    notes: str,
    chunks: list[dict],
    report: progress.Report = progress.ignore,
    rng: random.Random | None = None,
) -> dict:
    # Streamed for progress, as study_guide.call_llm is. A question with four
    # options and an explanation runs long for its notes, hence
    # the larger per-character estimate.
    text, stop_reason = progress.stream_structured(
        system=QUIZ_SYSTEM_PROMPT,
        content=build_quiz_prompt(notes, chunks),
        schema=QUIZ_SCHEMA,
        report=report,
        expected=progress.expected_chars(notes, per_note_char=2.5, floor=5000, ceiling=40000),
    )

    if stop_reason == "refusal":
        raise RuntimeError("Model declined to write a quiz for these notes")
    if stop_reason == "max_tokens":
        raise RuntimeError(f"Response hit max_tokens ({MAX_TOKENS}) before finishing")

    if text is None:
        raise ValueError(f"No text block in response (stop_reason={stop_reason!r})")

    quiz = _validate_quiz(json.loads(text), chunks)
    rng = rng or random.Random()
    quiz["questions"] = [_shuffle_options(q, rng) for q in quiz["questions"]]
    return quiz


def generate(
    study_space_id: str, notes: str, report: progress.Report = progress.ignore
) -> tuple[dict, list[dict]]:
    """One quiz. Returns it with the chunks it was given, so a caller that
    wants to score the grounding can see both - same signature as
    study_guide.generate."""
    sections = split_sections(notes)
    if not sections:
        raise EmptyNotesError("There are no notes in this document yet.")

    chunks = retrieve_for_notes(study_space_id, sections, report)
    if not chunks:
        raise EmptyNotesError(
            "No source material has been ingested for this study space yet, "
            "so there is nothing to ground a quiz in."
        )

    return call_llm(notes, chunks, report), chunks
