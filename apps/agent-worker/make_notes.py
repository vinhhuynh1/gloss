"""
Writing study notes from whole files, asked for in the space chat.

The opposite direction from study_guide.py. A guide starts from the notes the
group wrote and retrieves source material to check them against, which is why
it has nothing to do when the document is empty. This starts from the files
and writes the notes — the case of someone who has the slides and nothing
else.

So there is no retrieval here. Similarity search answers "which parts of the
material are about X", and notes need all of the material, in order: a lecture
read as its top-six most similar chunks skips most of the lecture. The files
are read front to back instead:

- from the original upload in sources.file_data, re-parsed with the same
  extract_pages ingestion uses, so a deck comes back one page per slide in
  slide order;
- or, for a source ingested from the command line with no stored file, from
  its chunks in the order they were written.

Material that fits in one prompt goes in whole. Longer material is read in
parts first — each part condensed to its key points, citations kept — and the
notes are written from those. Either way every [n] refers to one numbered page
of the original files, and _finalize drops any number that does not.
"""
import json
import re
from collections.abc import Callable

from agent import ANTHROPIC_MODEL, _get_client
from chat import Declined
from ingest import extract_pages
from prompts import (
    NOTES_EXTRACT_SYSTEM_PROMPT,
    NOTES_SYSTEM_PROMPT,
    PLAN_SYSTEM_PROMPT,
    _format_pages,
    build_extract_prompt,
    build_notes_prompt,
    build_plan_prompt,
)

# Up to this much text goes to the model in one pass — a long lecture deck or
# a textbook chapter. Past it, the material is condensed part by part first.
SINGLE_PASS_CHARS = 200_000
SECTION_CHARS = 100_000

# The ceiling on what one request will read at all, around a 400-page book.
# Refused with a message rather than truncated: notes that silently stop
# halfway through the material look complete and are not.
MAX_SOURCE_CHARS = 1_600_000

# Notes for a long deck are long, and thinking counts against this too.
# Streamed, so a large value costs nothing unless it is used.
MAX_TOKENS = 64_000

# Up to four digits: pages are numbered across every file in the request.
CITE_RE = re.compile(r"( ?)\[(\d{1,4})\]")

# How much of a cited page is kept on the citation. The chat shows it when a
# citation is clicked; a whole page of a textbook is more than that needs.
EXCERPT_CHARS = 1500


class NotesError(ValueError):
    """Nothing a retry would change: the files have no text, or too much."""


def pages_from_file(filename: str, content_type: str | None, data: bytes):
    return extract_pages(filename, content_type, data)


def pages_from_chunks(chunks: list[tuple[str | None, str]]):
    """Chunks back into pages: consecutive chunks with the same page_ref are
    one page. The chunker's overlap means a little text repeats at each
    seam, which the model shrugs off."""
    pages: list[tuple[str | None, str]] = []
    for page_ref, text in chunks:
        if pages and pages[-1][0] == page_ref:
            pages[-1] = (page_ref, pages[-1][1] + "\n" + text)
        else:
            pages.append((page_ref, text))
    return pages


def number_pages(files: list[tuple[str, list[tuple[str | None, str]]]]) -> list[dict]:
    """One numbered list across every file, blank pages dropped."""
    numbered = []
    for filename, pages in files:
        for page_ref, text in pages:
            if text.strip():
                numbered.append(
                    {
                        "n": len(numbered) + 1,
                        "filename": filename,
                        "page_ref": page_ref,
                        "text": text.strip(),
                    }
                )
    return numbered


def split_parts(pages: list[dict]) -> list[list[dict]]:
    """Consecutive pages in parts of about SECTION_CHARS. Never splits a page:
    a part boundary in the middle of a slide would give each half without the
    other's context."""
    parts: list[list[dict]] = [[]]
    size = 0
    for page in pages:
        if parts[-1] and size + len(page["text"]) > SECTION_CHARS:
            parts.append([])
            size = 0
        parts[-1].append(page)
        size += len(page["text"])
    return parts


def _run(
    system: str,
    content: str,
    on_text: Callable[[str], None] | None,
    output_config: dict | None = None,
) -> str:
    """One streamed call; returns the final text. Streamed even when nobody
    is watching, because at this max_tokens a non-streamed request risks the
    HTTP timeout."""
    extra = {"output_config": output_config} if output_config else {}
    with _get_client().beta.messages.stream(
        model=ANTHROPIC_MODEL,
        max_tokens=MAX_TOKENS,
        system=system,
        messages=[{"role": "user", "content": content}],
        # Same reasoning as agent.call_llm.
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        **extra,
    ) as stream:
        for text in stream.text_stream:
            if on_text is not None:
                on_text(text)
        final = stream.get_final_message()

    if final.stop_reason == "refusal":
        raise Declined("The assistant declined to write notes from these files.")
    if final.stop_reason == "max_tokens":
        raise RuntimeError(
            f"The notes hit max_tokens ({MAX_TOKENS}) before finishing. Try fewer "
            "files at once."
        )
    body = "".join(b.text for b in final.content if b.type == "text")
    if not body.strip():
        raise ValueError(f"No text in the response (stop_reason={final.stop_reason!r})")
    return body


def _finalize(body: str, pages: list[dict]) -> tuple[str, list[dict]]:
    """Same rule as chat._finalize: a page number that was never given is an
    invented source and is removed, not shown."""
    by_n = {p["n"]: p for p in pages}
    used: set[int] = set()

    def keep(match: re.Match) -> str:
        n = int(match.group(2))
        if n in by_n:
            used.add(n)
            return match.group(0)
        return ""

    body = CITE_RE.sub(keep, body).strip()
    citations = [
        {
            "n": n,
            # Pages are not chunks, and a file re-read from its upload has no
            # chunk ids at all. The filename and locator are what a reader
            # checks against.
            "chunk_id": None,
            "filename": by_n[n]["filename"],
            "page_ref": by_n[n]["page_ref"],
            "excerpt": by_n[n]["text"][:EXCERPT_CHARS],
        }
        for n in sorted(used)
    ]
    return body, citations


def has_notes(body: str, citations: list[dict]) -> bool:
    """Whether a notes response is notes at all. Asked to add only what the
    group's notes are missing, the model answers "nothing is missing" in one
    plain sentence, as NOTES_SYSTEM_PROMPT's caller tells it to — no heading,
    no bullet, nothing cited. That must not be inserted into the document."""
    if citations:
        return True
    return any(
        line.lstrip().startswith(("#", "- ", "* ")) for line in body.splitlines()
    )


def _checked_pages(files) -> list[dict]:
    pages = number_pages(files)
    if not pages:
        raise NotesError(
            "There is no readable text in those files. If they are scanned, or "
            "slides made of images, they need OCR first."
        )
    total = sum(len(p["text"]) for p in pages)
    if total > MAX_SOURCE_CHARS:
        raise NotesError(
            f"Those files hold about {total // 1000:,}k characters of text, more "
            f"than one request reads ({MAX_SOURCE_CHARS // 1000:,}k). Make notes "
            "from fewer files at a time."
        )
    return pages


# A plan is proposed from the start of every page rather than all of it: the
# structure of a lecture is in its titles and opening lines, and reading a
# whole book in full to propose headings would cost as much as writing the
# notes. Enough per page to see what it is about, less when there are many.
PLAN_MIN_PAGE_CHARS = 200
PLAN_MAX_PAGE_CHARS = 1500

MAX_PLAN_SECTIONS = 30

PLAN_SCHEMA = {
    "type": "object",
    "properties": {
        "sections": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "heading": {"type": "string"},
                    "summary": {"type": "string"},
                    "pages": {"type": "array", "items": {"type": "integer"}},
                },
                "required": ["heading", "summary", "pages"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["sections"],
    "additionalProperties": False,
}


def plan(
    files: list[tuple[str, list[tuple[str | None, str]]]],
    instructions: str,
    existing_notes: str,
) -> list[dict]:
    """An outline for the notes: [{heading, summary, pages}]. Page numbers
    the model invents are dropped, as citations are; a section left with no
    heading is dropped whole. May be empty — the existing notes may already
    cover everything."""
    pages = _checked_pages(files)
    per_page = max(
        PLAN_MIN_PAGE_CHARS, min(PLAN_MAX_PAGE_CHARS, SINGLE_PASS_CHARS // len(pages))
    )
    material = _format_pages([{**p, "text": p["text"][:per_page]} for p in pages])
    raw = _run(
        PLAN_SYSTEM_PROMPT,
        build_plan_prompt(material, instructions, existing_notes),
        None,
        output_config={"format": {"type": "json_schema", "schema": PLAN_SCHEMA}},
    )
    valid = {p["n"] for p in pages}
    sections = []
    for section in json.loads(raw).get("sections", []):
        heading = (section.get("heading") or "").strip()
        if not heading:
            continue
        sections.append(
            {
                "heading": heading[:200],
                "summary": (section.get("summary") or "").strip()[:500],
                "pages": [n for n in section.get("pages") or [] if n in valid],
            }
        )
    return sections[:MAX_PLAN_SECTIONS]


def plan_as_text(sections: list[dict]) -> str:
    """The plan as a message body. The chat draws the outline from its own
    column; this is what the thread's history shows the model on later
    questions, and what a client that knows nothing of outlines would show."""
    if not sections:
        return "Your notes already cover this material — I have nothing to add."
    return "Here is the plan for the notes:\n\n" + "\n".join(
        f"- **{s['heading']}**" + (f" — {s['summary']}" if s["summary"] else "")
        for s in sections
    )


def generate(
    files: list[tuple[str, list[tuple[str | None, str]]]],
    instructions: str,
    existing_notes: str,
    on_text: Callable[[str], None],
    on_progress: Callable[[str], None],
    outline: list[dict] | None = None,
) -> tuple[str, list[dict]]:
    """files is [(filename, [(page_ref, text)])] in the order asked for.
    Returns (body, citations), body in the format NOTES_SYSTEM_PROMPT asks
    for. on_progress reports the reading phase of a long request, which
    streams nothing a person can see. outline, when given, is the plan the
    group approved, and the notes follow it."""
    pages = _checked_pages(files)
    total = sum(len(p["text"]) for p in pages)

    extracted = total > SINGLE_PASS_CHARS
    if not extracted:
        material = _format_pages(pages)
    else:
        parts = split_parts(pages)
        extracts = []
        for i, part in enumerate(parts, start=1):
            on_progress(f"Reading the material, part {i} of {len(parts)}…")
            extracts.append(
                _run(NOTES_EXTRACT_SYSTEM_PROMPT, build_extract_prompt(part, instructions), None)
            )
        material = "\n\n".join(extracts)

    on_progress("Writing notes…")
    body = _run(
        NOTES_SYSTEM_PROMPT,
        build_notes_prompt(
            material, instructions, existing_notes, extracted=extracted, outline=outline
        ),
        on_text,
    )
    return _finalize(body, pages)
