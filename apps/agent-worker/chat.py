"""
Answering a question in the space chat.

The unit is one question in the context of a shared thread. Everything that
makes it different from agent.py follows from that:

- It streams. Someone is watching the answer appear, so the text is handed to
  a callback as it arrives and worker.py writes it into the row every so
  often. The final message, not the streamed deltas, is what is kept: a
  mid-stream refusal re-runs on the fallback model inside the same call, and
  the streamed text can then contain the start of an answer that was
  abandoned.

- It cites by number, not by chunk id. The answer is prose a person reads, so
  excerpts are numbered in the prompt and cited as [n]; _finalize maps the
  numbers back to chunks and drops any the model invented, the same rule
  _validate applies in agent.py.

- Retrieval covers the previous question too. "What about the second
  stage?" is a useless query on its own — it embeds to nothing about
  respiration. A few chunks for the question before it keep a follow-up
  grounded in the topic it follows up on, without letting an unrelated
  earlier topic crowd out the new one.
"""
import re
from collections.abc import Callable

from agent import ANTHROPIC_MODEL, _get_client
from prompts import CHAT_SYSTEM_PROMPT, build_chat_question
from retrieval import search

TOP_K = 6
PREVIOUS_TOP_K = 3

# How much of the thread the model sees, in messages. Enough for a follow-up
# to know what "it" is; not so much that one busy afternoon's thread turns
# every new question into a long, slow, expensive prompt.
HISTORY_MESSAGES = 12

# Thinking is on by default for this model and counts against this — see the
# note on MAX_TOKENS in agent.py.
MAX_TOKENS = 16000

# Up to two digits: the prompt never numbers more than TOP_K + PREVIOUS_TOP_K
# excerpts, and a bracketed three-digit number in an answer is far likelier
# to be a year or a quantity than a citation. The optional leading space is
# taken with the marker so removing an invented one leaves no double space.
CITE_RE = re.compile(r"( ?)\[(\d{1,2})\]")

class Declined(RuntimeError):
    """The model declined, after the server-side fallback had its turn too.
    Not worth a retry: the same question will be declined the same way."""


NO_MATERIAL_REPLY = (
    "There's no source material in this space yet, so I have nothing to answer "
    "from. Upload slides, readings or notes in the Sources panel, then ask again."
)


def retrieve(study_space_id: str, question: str, previous_question: str | None) -> list[dict]:
    chunks = search(study_space_id, question, TOP_K)
    if previous_question:
        seen = {c["id"] for c in chunks}
        chunks += [
            c
            for c in search(study_space_id, previous_question, PREVIOUS_TOP_K)
            if c["id"] not in seen
        ]
    return chunks


def build_messages(
    history: list[tuple[str, str | None, str]],
    author: str,
    question: str,
    chunks: list[dict],
) -> list[dict]:
    """history is [(role, author_name, body)], oldest first, finished messages
    only. Earlier questions go in without their excerpts — they were retrieved
    for a different question, and resending them would multiply the prompt by
    the length of the thread for no gain."""
    messages = []
    for role, name, body in history:
        if role == "user":
            messages.append({"role": "user", "content": f"{name or 'A member'}: {body}"})
        elif body:
            messages.append({"role": "assistant", "content": body})
    # The API requires the conversation to open with a user turn; a history
    # window that starts partway through can begin on an answer.
    while messages and messages[0]["role"] == "assistant":
        messages.pop(0)
    messages.append(
        {"role": "user", "content": build_chat_question(author, question, chunks)}
    )
    return messages


def _finalize(body: str, chunks: list[dict]) -> tuple[str, list[dict]]:
    """Map [n] markers back to chunks. A number that was never given is an
    invented source, and is removed from the text rather than shown as a
    citation that leads nowhere."""
    used: set[int] = set()

    def keep(match: re.Match) -> str:
        n = int(match.group(2))
        if 1 <= n <= len(chunks):
            used.add(n)
            return match.group(0)
        return ""

    body = CITE_RE.sub(keep, body).strip()
    citations = [
        {
            "n": n,
            "chunk_id": chunks[n - 1]["id"],
            "filename": chunks[n - 1]["filename"],
            "page_ref": chunks[n - 1]["page_ref"],
            "excerpt": chunks[n - 1]["text"],
        }
        for n in sorted(used)
    ]
    return body, citations


def answer(
    study_space_id: str,
    history: list[tuple[str, str | None, str]],
    author: str,
    question: str,
    on_text: Callable[[str], None],
) -> tuple[str, list[dict]]:
    """Retrieve, then stream the answer. Returns (body, citations).

    A space with nothing ingested gets a fixed reply and no model call: there
    is nothing to ground an answer in, and asking anyway only invites one from
    outside knowledge."""
    previous = next(
        (body for role, _name, body in reversed(history) if role == "user"), None
    )
    chunks = retrieve(study_space_id, question, previous)
    if not chunks:
        return NO_MATERIAL_REPLY, []

    with _get_client().beta.messages.stream(
        model=ANTHROPIC_MODEL,
        max_tokens=MAX_TOKENS,
        system=CHAT_SYSTEM_PROMPT,
        messages=build_messages(history, author, question, chunks),
        # medium rather than the default high: this is a person waiting on a
        # reply grounded in six excerpts, not a whole-document synthesis, and
        # the wait before the first word is most of what they experience.
        output_config={"effort": "medium"},
        # Same reasoning as agent.call_llm: a policy decline is re-run on the
        # recommended fallback rather than ending the answer.
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
    ) as stream:
        for text in stream.text_stream:
            on_text(text)
        final = stream.get_final_message()

    if final.stop_reason == "refusal":
        raise Declined("The assistant declined to answer this question.")
    if final.stop_reason == "max_tokens":
        raise RuntimeError(f"The answer hit max_tokens ({MAX_TOKENS}) before finishing.")

    body = "".join(b.text for b in final.content if b.type == "text")
    if not body.strip():
        raise ValueError(f"No text in the response (stop_reason={final.stop_reason!r})")
    return _finalize(body, chunks)
