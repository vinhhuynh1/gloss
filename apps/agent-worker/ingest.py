"""
Ingestion pipeline: parse an uploaded source file into searchable chunks.

Usage:
    python ingest.py <path-to-pdf> <study_space_id> <uploaded_by_user_id>

The CLI above is the direct path — a file on your disk, ingested now. The
same functions also back worker.py, which ingests files uploaded through the
web app and therefore only ever sees bytes out of Postgres, never a path.
Everything here that touches a file does so through bytes for that reason.
"""
import io
import os
import sys
import uuid
from pathlib import Path

import psycopg
from dotenv import load_dotenv
from pypdf import PdfReader

from embeddings import embed_batch

# Anchored to this file rather than the CWD so the worker's .env is found
# no matter where the process was started from — eval/run_eval.py imports
# this module while running out of eval/, where a bare load_dotenv() finds
# nothing and DATABASE_URL silently falls back to the default below.
load_dotenv(Path(__file__).with_name(".env"))

DATABASE_URL = os.getenv(
    "DATABASE_URL", "postgresql://study_notes:study_notes@localhost:5432/study_notes"
)

CHUNK_SIZE_CHARS = 1200
CHUNK_OVERLAP_CHARS = 200

# (page_ref, text). page_ref is None when the format carries no locator to
# cite — a heading-less .txt file — and a citation on such a chunk names the
# file but no position within it.
Page = tuple[str | None, str]


def extract_pages_from_pdf(data: bytes) -> list[Page]:
    """One (page_ref, text) pair per PDF page."""
    reader = PdfReader(io.BytesIO(data))
    return [
        (f"p. {i + 1}", page.extract_text() or "") for i, page in enumerate(reader.pages)
    ]


def split_markdown_sections(text: str) -> list[Page]:
    """Split on `## ` headings into (page_ref, text) pairs.

    The heading becomes the page_ref, which is what shows up in a citation —
    for a real PDF that slot holds "p. 14" instead. Returns an empty list if
    the text has no `## ` headings at all; callers decide whether that is an
    error (seed_demo.py) or just an unstructured file (extract_pages_from_text).
    """
    pages: list[Page] = []
    page_ref, buf = None, []
    for line in text.splitlines():
        if line.startswith("## "):
            if page_ref is not None:
                pages.append((page_ref, "\n".join(buf).strip()))
            page_ref, buf = line[3:].strip(), []
        elif page_ref is not None:
            buf.append(line)
    if page_ref is not None:
        pages.append((page_ref, "\n".join(buf).strip()))
    return [(ref, body) for ref, body in pages if body]


def extract_pages_from_text(text: str) -> list[Page]:
    """Markdown or plain text, with headings used as locators where they exist.

    The fallback is one unlabelled page rather than invented section numbers.
    A citation reading "part 3" would look like a real locator while pointing
    at nothing a reader could find in the file, which is worse for a tool whose
    whole claim is that its citations can be checked.
    """
    sections = split_markdown_sections(text)
    if sections:
        return sections
    return [(None, text)] if text.strip() else []


def extract_pages(filename: str, content_type: str | None, data: bytes) -> list[Page]:
    """Dispatch on the file type. The single place that knows which parser
    goes with which upload, so the API's allowlist and the worker agree."""
    lowered = filename.lower()
    if lowered.endswith(".pdf") or content_type == "application/pdf":
        return extract_pages_from_pdf(data)
    return extract_pages_from_text(data.decode("utf-8", errors="replace"))


def chunk_text(text: str) -> list[str]:
    """Simple sliding-window chunker. Swap for a semantic/paragraph-aware
    chunker once you've measured whether it actually improves the eval score
    — don't tune this on vibes, see eval/run_eval.py."""
    chunks = []
    start = 0
    while start < len(text):
        end = start + CHUNK_SIZE_CHARS
        chunks.append(text[start:end])
        # Stop at the end rather than stepping back by the overlap: a section
        # between CHUNK_SIZE - CHUNK_OVERLAP and CHUNK_SIZE long would
        # otherwise emit a second chunk wholly contained in the first, and a
        # short duplicate tail can out-rank the full passage for a short query.
        if end >= len(text):
            break
        start = end - CHUNK_OVERLAP_CHARS
    return [c.strip() for c in chunks if c.strip()]


def build_chunks(pages: list[Page]) -> list[Page]:
    """Flatten pages into (page_ref, chunk) pairs, keeping each chunk's
    locator attached — the page_ref is what makes a citation checkable, so it
    has to survive chunking rather than being recovered later."""
    return [(page_ref, chunk) for page_ref, text in pages for chunk in chunk_text(text)]


def ingest_pages(
    pages: list[Page],
    study_space_id: str,
    uploaded_by: str,
    filename: str,
) -> str | None:
    """Chunk, embed, and store already-extracted (page_ref, text) pages under
    a newly created source row.

    Split out of ingest() so any source format can reuse the pipeline —
    ingest() supplies pages from a PDF, seed_demo.py from a text file.
    Returns the new source id, or None if there was nothing to store.

    worker.py deliberately does NOT call this: its source row already exists,
    created by the upload that queued the work. It reuses build_chunks() and
    embed_batch() instead.
    """
    # Collect every chunk first so they can be embedded in one batch —
    # far faster than embedding them one at a time in the loop.
    pending = build_chunks(pages)

    if not pending:
        print(f"No extractable text found in {filename}. Is it a scanned PDF?")
        return None

    print(f"Embedding {len(pending)} chunks (first run downloads the model)...")
    vectors = embed_batch([chunk for _, chunk in pending])

    source_id = str(uuid.uuid4())

    with psycopg.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO sources (id, study_space_id, filename, uploaded_by, status) "
                "VALUES (%s, %s, %s, %s, 'ready')",
                (source_id, study_space_id, filename, uploaded_by),
            )
            cur.executemany(
                "INSERT INTO source_chunks (id, source_id, text, embedding, page_ref) "
                "VALUES (%s, %s, %s, %s, %s)",
                [
                    (str(uuid.uuid4()), source_id, chunk, vector, page_ref)
                    for (page_ref, chunk), vector in zip(pending, vectors)
                ],
            )

    print(f"Ingested {filename}: {len(pending)} chunks under source {source_id}")
    return source_id


def ingest(pdf_path: str, study_space_id: str, uploaded_by: str):
    filename = os.path.basename(pdf_path)
    data = Path(pdf_path).read_bytes()
    return ingest_pages(
        extract_pages(filename, None, data),
        study_space_id,
        uploaded_by,
        filename,
    )


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print(__doc__)
        sys.exit(1)
    ingest(sys.argv[1], sys.argv[2], sys.argv[3])
