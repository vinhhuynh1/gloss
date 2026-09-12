"""
Optional second opinion for run_eval.py --judge.

The deterministic grounding score in run_eval.py asks a narrow question: did
the verdict cite the section the test case says it should have? That is cheap,
reproducible, and it is the number to track — a score that moves means the
agent moved, never the grader.

It does have a blind spot. A verdict can cite exactly the right section and
still say something that excerpt does not support, and the declared-source
check cannot see that. This module closes it by asking the model directly
whether the cited excerpt supports the suggestion built on it.

Kept off by default and reported as its own number, never folded into the
headline. A model-graded metric drifts when the judge model or its prompt
changes, so a run-to-run delta in it is ambiguous in a way the declared-source
score is not. Use it to audit a run you are about to write up, not to hillclimb
against.
"""
import json
import os

import agent

# Overridable so the judge can be held fixed while the agent's model is swept —
# comparing two agent models with a judge that changed underneath them measures
# nothing.
JUDGE_MODEL = os.getenv("JUDGE_MODEL", agent.ANTHROPIC_MODEL)

JUDGE_SYSTEM_PROMPT = """\
You are grading one output of a study-notes assistant. The assistant was \
shown a passage of a student's notes plus excerpts from the course's source \
material, and it produced a suggestion grounded in one specific excerpt.

You are given the notes passage, the suggestion, and the single excerpt the \
assistant cited. Decide one thing only: does that excerpt actually support \
the suggestion?

Judge strictly and judge only what is in front of you:
- For a contradiction, the excerpt must genuinely conflict with the notes \
passage. An excerpt merely on the same topic is not support.
- For a citation, the excerpt must state the claim the notes make, not a \
related one.
- For a gap_fill, the added text must be derivable from the excerpt alone. \
Anything correct but absent from the excerpt is unsupported.

Do not use outside knowledge. A suggestion can be perfectly true and still \
unsupported by this excerpt, and that is the case you are here to catch.
"""

JUDGE_SCHEMA = {
    "type": "object",
    "properties": {
        "supported": {"type": "boolean"},
        "why": {"type": "string"},
    },
    "required": ["supported", "why"],
    "additionalProperties": False,
}


def build_judge_prompt(notes_passage: str, verdict: dict, chunk: dict) -> str:
    return f"""\
NOTES PASSAGE:
{notes_passage}

SUGGESTION TYPE: {verdict["type"]}

PROPOSED TEXT:
{verdict["proposed_text"]}

THE EXCERPT THE ASSISTANT CITED [{chunk.get("page_ref") or "unknown location"}]:
{chunk["text"]}

Does that excerpt support the suggestion?
"""


def judge_grounding(notes_passage: str, verdict: dict, chunk: dict) -> dict:
    """Returns {"supported": bool | None, "why": str}.

    `supported` is None when the judge could not return a verdict — treated as
    unjudged rather than as a failure, so a refusal on one case does not
    silently depress the reported number.
    """
    response = agent._get_client().beta.messages.create(
        model=JUDGE_MODEL,
        max_tokens=agent.MAX_TOKENS,
        system=JUDGE_SYSTEM_PROMPT,
        messages=[
            {"role": "user", "content": build_judge_prompt(notes_passage, verdict, chunk)}
        ],
        output_config={"format": {"type": "json_schema", "schema": JUDGE_SCHEMA}},
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
    )

    if response.stop_reason in ("refusal", "max_tokens"):
        return {"supported": None, "why": f"judge did not answer ({response.stop_reason})"}

    text = next((b.text for b in response.content if b.type == "text"), None)
    if text is None:
        return {"supported": None, "why": "judge returned no text block"}

    return json.loads(text)
