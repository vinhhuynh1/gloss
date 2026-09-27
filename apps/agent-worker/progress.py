"""
Progress for study guides and flashcard decks while they are written.

Both are a retrieval per section of the notes, then one long model call that
returns structured JSON. The retrieval half is counted exactly — one step per
section. The model half cannot be: nothing says how long the answer will be
until it ends. So it is estimated from how much JSON has streamed in against
how much a document this size usually produces, and held below 100 until the
row is actually done. An estimate that moves is still more honest than one
unchanging "Writing…", which looked the same as a worker that had stopped.

The ranges are what the editor shows:

    2        claimed, starting
    5 - 35   finding source material, one step per section
    35 - 95  writing, by streamed output against the estimate, slowing as it
             nears the end rather than stopping there
"""
import math
from collections.abc import Callable

from agent import ANTHROPIC_MODEL, MAX_TOKENS, _get_client

STAGE_STARTING = "Starting"
STAGE_RETRIEVING = "Finding source material"
STAGE_WRITING = "Writing"

RETRIEVE_START = 5
RETRIEVE_END = 35
WRITE_END = 95

# (stage, percent). Callers pass one; the default does nothing, so the eval
# harness and the CLI keep calling generate() exactly as before.
Report = Callable[[str, int], None]


def ignore(_stage: str, _percent: int) -> None:
    return None


def retrieval_step(report: Report, done: int, total: int) -> None:
    span = RETRIEVE_END - RETRIEVE_START
    report(STAGE_RETRIEVING, RETRIEVE_START + round(span * done / max(total, 1)))


def expected_chars(notes: str, *, per_note_char: float, floor: int, ceiling: int) -> int:
    """Roughly how much JSON a document this long produces. It only has to
    keep the bar moving at about the right speed, not predict the end.

    Calibrated on one guide from the seed course: 2.5k characters of notes
    produced about 7.7k of JSON, so short notes run to three times their own
    length once every point carries a chunk id. The floor covers that; the
    ratio is for longer notes, where the overhead matters less."""
    return max(floor, min(ceiling, int(len(notes) * per_note_char)))


def stream_structured(
    *,
    system: str,
    content: str,
    schema: dict,
    report: Report,
    expected: int,
) -> tuple[str | None, str | None]:
    """One structured-output call, streamed so its progress can be counted.
    Returns (text, stop_reason) exactly as the non-streamed call did, for the
    callers' own refusal and max_tokens handling.

    Streaming changes nothing about the request: the same model, schema,
    fallback and token limit as before. It only lets the text be measured as
    it arrives.
    """
    report(STAGE_WRITING, RETRIEVE_END)
    received = 0
    span = WRITE_END - RETRIEVE_END
    with _get_client().beta.messages.stream(
        model=ANTHROPIC_MODEL,
        max_tokens=MAX_TOKENS,
        system=system,
        messages=[{"role": "user", "content": content}],
        output_config={"format": {"type": "json_schema", "schema": schema}},
        # Same reasoning as agent.call_llm: a policy decline is re-run on the
        # recommended fallback rather than coming back as a refusal.
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
    ) as stream:
        for text in stream.text_stream:
            received += len(text)
            # Approaches WRITE_END without reaching it: 63% of the span at
            # the expected length, 86% at twice it, 95% at three times. A
            # straight line capped at the end sat at 95% for half the run
            # whenever a guide came out longer than expected, which is the
            # "looks stuck" this exists to avoid.
            fraction = 1 - math.exp(-received / expected)
            report(STAGE_WRITING, RETRIEVE_END + int(span * fraction))
        final = stream.get_final_message()

    text = next((b.text for b in final.content if b.type == "text"), None)
    return text, final.stop_reason
