"""
The retrieval half of the RAG pipeline, in one place.

agent.py needs this to ground a suggestion; search.py needs it to answer
"is retrieval actually any good?" without spending a token on the LLM. Those
two must ask the database exactly the same question — a search CLI that
retrieved slightly differently from the agent would be a debugging tool that
lies, telling you retrieval is fine while the agent is fed something else.

The same reasoning is why embeddings.py is shared rather than copied; see the
docstring there.
"""
import os
from pathlib import Path

import psycopg
from dotenv import load_dotenv

from embeddings import embed, embed_batch

load_dotenv(Path(__file__).with_name(".env"))

DATABASE_URL = os.getenv(
    "DATABASE_URL", "postgresql://study_notes:study_notes@localhost:5432/study_notes"
)

DEFAULT_TOP_K = 5


def search(study_space_id: str, query: str, top_k: int = DEFAULT_TOP_K) -> list[dict]:
    """Top-K most semantically similar chunks, scoped to one study space.

    That WHERE clause on study_space_id is the whole isolation story: one
    course's material can never surface in another course's answers, and it
    holds no matter how many spaces share the database, because the filter
    lives with the query rather than in application code that could forget it.

    `score` is cosine similarity in [0, 1] — 1 minus the `<=>` distance, which
    is a distance and therefore sorts the opposite way. Reported because a
    top-5 result at 0.2 and one at 0.8 mean very different things about
    whether the material covers the question at all, and the raw ranking hides
    that distinction completely.
    """
    with psycopg.connect(DATABASE_URL) as conn:
        return _query(conn, study_space_id, embed(query), top_k)


def search_many(study_space_id: str, queries: list[str], top_k: int = DEFAULT_TOP_K) -> list[list[dict]]:
    """search() for several queries at once: one embedding batch and one
    connection, rather than a model call and a fresh connection per query.
    A study guide searches once per section of the notes, and against a remote
    database the connection handshakes alone were seconds of the wait.

    The same SQL as search(), so the two cannot drift apart."""
    if not queries:
        return []
    vectors = embed_batch(queries)
    with psycopg.connect(DATABASE_URL) as conn:
        return [_query(conn, study_space_id, v, top_k) for v in vectors]


def _query(conn, study_space_id: str, query_embedding: list[float], top_k: int) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT sc.id,
                   sc.text,
                   sc.page_ref,
                   s.filename,
                   1 - (sc.embedding <=> %s::vector) AS score
              FROM source_chunks sc
              JOIN sources s ON s.id = sc.source_id
             WHERE s.study_space_id = %s
             ORDER BY sc.embedding <=> %s::vector
             LIMIT %s
            """,
            (str(query_embedding), study_space_id, str(query_embedding), top_k),
        )
        rows = cur.fetchall()

    return [
        {
            "id": str(row[0]),
            "text": row[1],
            "page_ref": row[2],
            "filename": row[3],
            "score": float(row[4]),
        }
        for row in rows
    ]
