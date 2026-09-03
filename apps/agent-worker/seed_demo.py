"""
Seeds a study space with source material so eval/run_eval.py has something
to retrieve against.

The eval needs three things the schema requires but nothing else in the repo
creates: a user, a study space owned by that user, and ingested source
chunks. This wires up all three from a plain text/markdown file, so you can
get a real score before the upload UI exists.

Re-running is safe: it reuses the same seed user and study space and
replaces that space's sources rather than stacking duplicates.

Usage:
    python seed_demo.py [path-to-source.md]

Prints the study_space_id and document_id to use:
    STUDY_SPACE_ID=<uuid> python ../../eval/run_eval.py
"""
import os
import sys
import uuid
from pathlib import Path

import psycopg
from dotenv import load_dotenv

from ingest import ingest_pages

load_dotenv(Path(__file__).with_name(".env"))

DATABASE_URL = os.getenv(
    "DATABASE_URL", "postgresql://study_notes:study_notes@localhost:5432/study_notes"
)

# Stable identifiers so re-running updates the same rows instead of piling up
# a new study space every time.
SEED_EMAIL = "seed@example.invalid"
SEED_NAME = "Seed User"
SEED_COURSE = "BIOL 201 — Cellular Respiration (seed)"

DEFAULT_SOURCE = (
    Path(__file__).parent.parent.parent / "eval" / "test_cases" / "sample_course_source.md"
)


def split_into_pages(markdown: str) -> list[tuple[str, str]]:
    """Split on `## ` headings into (page_ref, text) pairs.

    The heading becomes the page_ref, which is what shows up in a citation —
    for a real PDF ingest.py uses "p. 14" here instead.
    """
    pages: list[tuple[str, str]] = []
    page_ref, buf = None, []
    for line in markdown.splitlines():
        if line.startswith("## "):
            if page_ref is not None:
                pages.append((page_ref, "\n".join(buf).strip()))
            page_ref, buf = line[3:].strip(), []
        elif page_ref is not None:
            buf.append(line)
    if page_ref is not None:
        pages.append((page_ref, "\n".join(buf).strip()))
    return [(ref, text) for ref, text in pages if text]


def seed(source_path: Path) -> tuple[str, str]:
    markdown = source_path.read_text(encoding="utf-8")
    pages = split_into_pages(markdown)
    if not pages:
        raise SystemExit(f"No `## ` sections found in {source_path}")

    with psycopg.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO users (email, name) VALUES (%s, %s)
                ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
                RETURNING id
                """,
                (SEED_EMAIL, SEED_NAME),
            )
            user_id = str(cur.fetchone()[0])

            cur.execute(
                "SELECT id FROM study_spaces WHERE course_name = %s AND created_by = %s",
                (SEED_COURSE, user_id),
            )
            row = cur.fetchone()
            if row:
                study_space_id = str(row[0])
                # Replace this space's material rather than adding a second
                # copy of every chunk — duplicates would skew retrieval.
                cur.execute(
                    "DELETE FROM sources WHERE study_space_id = %s", (study_space_id,)
                )
            else:
                study_space_id = str(uuid.uuid4())
                cur.execute(
                    "INSERT INTO study_spaces (id, course_name, created_by) "
                    "VALUES (%s, %s, %s)",
                    (study_space_id, SEED_COURSE, user_id),
                )

            cur.execute(
                "INSERT INTO study_space_members (study_space_id, user_id, role) "
                "VALUES (%s, %s, 'owner') ON CONFLICT DO NOTHING",
                (study_space_id, user_id),
            )

            cur.execute(
                "SELECT id FROM documents WHERE study_space_id = %s", (study_space_id,)
            )
            row = cur.fetchone()
            if row:
                document_id = str(row[0])
            else:
                document_id = str(uuid.uuid4())
                cur.execute(
                    "INSERT INTO documents (id, study_space_id) VALUES (%s, %s)",
                    (document_id, study_space_id),
                )

    ingest_pages(pages, study_space_id, user_id, source_path.name)
    return study_space_id, document_id


if __name__ == "__main__":
    source = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SOURCE
    if not source.exists():
        raise SystemExit(f"Source file not found: {source}")

    study_space_id, document_id = seed(source)
    print()
    print(f"study_space_id: {study_space_id}")
    print(f"document_id:    {document_id}")
    print()
    print("Run the eval with:")
    print(f"  STUDY_SPACE_ID={study_space_id} python ../../eval/run_eval.py")
