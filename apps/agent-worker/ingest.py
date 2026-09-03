"""
Ingestion pipeline: parse an uploaded source file into searchable chunks.

Usage:
    python ingest.py <path-to-pdf> <study_space_id> <uploaded_by_user_id>
"""
import os
import sys
import uuid

import psycopg
from dotenv import load_dotenv
from pypdf import PdfReader

from embeddings import embed_batch

load_dotenv()

DATABASE_URL = os.getenv(
    "DATABASE_URL", "postgresql://study_notes:study_notes@localhost:5432/study_notes"
)

CHUNK_SIZE_CHARS = 1200
CHUNK_OVERLAP_CHARS = 200


def extract_pages(pdf_path: str) -> list[tuple[str, str]]:
    """Returns a list of (page_ref, page_text) tuples."""
    reader = PdfReader(pdf_path)
    return [
        (f"p. {i + 1}", page.extract_text() or "") for i, page in enumerate(reader.pages)
    ]


def chunk_text(text: str) -> list[str]:
    """Simple sliding-window chunker. Swap for a semantic/paragraph-aware
    chunker once you've measured whether it actually improves the eval score
    — don't tune this on vibes, see eval/run_eval.py."""
    chunks = []
    start = 0
    while start < len(text):
        end = start + CHUNK_SIZE_CHARS
        chunks.append(text[start:end])
        start = end - CHUNK_OVERLAP_CHARS
    return [c.strip() for c in chunks if c.strip()]


def ingest(pdf_path: str, study_space_id: str, uploaded_by: str):
    # Collect every chunk first so they can be embedded in one batch —
    # far faster than embedding them one at a time in the loop.
    pending: list[tuple[str, str]] = []  # (page_ref, chunk_text)
    for page_ref, page_text in extract_pages(pdf_path):
        for chunk in chunk_text(page_text):
            pending.append((page_ref, chunk))

    if not pending:
        print(f"No extractable text found in {pdf_path}. Is it a scanned PDF?")
        return

    print(f"Embedding {len(pending)} chunks (first run downloads the model)...")
    vectors = embed_batch([chunk for _, chunk in pending])

    source_id = str(uuid.uuid4())
    filename = os.path.basename(pdf_path)

    with psycopg.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO sources (id, study_space_id, filename, uploaded_by) "
                "VALUES (%s, %s, %s, %s)",
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


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print(__doc__)
        sys.exit(1)
    ingest(sys.argv[1], sys.argv[2], sys.argv[3])
