"""
Scoring an attempt and turning attempts into weak spots.

Pure functions, kept out of the router so the rule is testable without a
database and lives in exactly one place. The browser is told `weak` rather
than given the threshold, so changing it here changes it everywhere.
"""
from collections.abc import Iterable

# Below this many questions a section has not been tested enough to call it
# weak: one miss is a slip, not a pattern.
MIN_ASKED = 2
# Strictly below. 7 of 10 is a pass.
WEAK_BELOW = 0.7


def score_answers(questions: list[dict], answers: list[int]) -> int:
    return sum(1 for q, a in zip(questions, answers, strict=False) if q["correct_index"] == a)


def tally(rows: Iterable[tuple[list[int], list[str], list[int]]]) -> list[dict]:
    """Per-section totals from (answers, sections, correct_indexes) rows, one
    row per quiz (the caller picks the latest attempt). Weakest first.

    A row whose three lists differ in length is skipped rather than zipped
    short: it would credit answers to the wrong questions.
    """
    counts: dict[str, list[int]] = {}
    for answers, sections, correct in rows:
        if not len(answers) == len(sections) == len(correct):
            continue
        for answer, section, right in zip(answers, sections, correct, strict=True):
            asked_correct = counts.setdefault(section, [0, 0])
            asked_correct[0] += 1
            asked_correct[1] += int(answer == right)

    spots = [
        {
            "section": section,
            "asked": asked,
            "correct": correct,
            "weak": asked >= MIN_ASKED and correct / asked < WEAK_BELOW,
        }
        for section, (asked, correct) in counts.items()
    ]
    spots.sort(key=lambda s: (s["correct"] / s["asked"], -s["asked"]))
    return spots
