"""
Ingestion worker: turns uploaded files into searchable chunks.

    python worker.py                      # run forever, processing uploads
    python worker.py --once               # drain the queue and exit
    python worker.py --requeue [space_id] # re-chunk material already ingested

`sources` doubles as the queue. A dedicated broker (Redis, SQS, Celery) would
be the reflex here, but it would be a second piece of infrastructure to run,
deploy, and reason about in exchange for nothing this workload needs: the
volume is a handful of files per study group, the work is idempotent, and
Postgres is already a hard dependency of both processes. `FOR UPDATE SKIP
LOCKED` gives the one property that actually matters — two workers never claim
the same row — in one statement.

Run exactly as many of these as you like. Unlike apps/realtime, which must
stay at one replica, this is safely horizontal.
"""
import argparse
import os
import sys
import time
import uuid
from pathlib import Path

import psycopg
from dotenv import load_dotenv

from embeddings import embed_batch
from ingest import build_chunks, extract_pages

load_dotenv(Path(__file__).with_name(".env"))

DATABASE_URL = os.getenv(
    "DATABASE_URL", "postgresql://study_notes:study_notes@localhost:5432/study_notes"
)

POLL_INTERVAL_SECONDS = float(os.getenv("INGEST_POLL_SECONDS", "2"))

# A row claimed longer ago than this is assumed to belong to a worker that
# died mid-pass — killed, redeployed, out of memory — and goes back on the
# queue. Without this, a crash strands the upload in 'processing' forever and
# the person who uploaded it just watches a spinner. Generous on purpose: a
# 200-page PDF on a cold model load is minutes, and reclaiming a row that is
# still being worked on costs duplicated effort.
STALE_CLAIM_SECONDS = int(os.getenv("INGEST_STALE_CLAIM_SECONDS", "900"))

# A file that crashes the parser fails the same way every time. Retry a couple
# of times to ride out the transient causes (a restart, a blip talking to the
# database), then stop and show the error rather than burning a worker on it
# in a loop. POST /sources/{id}/retry resets the counter.
MAX_ATTEMPTS = int(os.getenv("INGEST_MAX_ATTEMPTS", "3"))

# Postgres will take a longer error string happily; this is about the UI,
# where a full traceback in a source card is noise rather than information.
MAX_ERROR_CHARS = 500


def reclaim_stale(conn) -> int:
    """Return timed-out claims to the queue. Returns how many were reclaimed."""
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE sources
               SET status = 'pending', claimed_at = NULL
             WHERE status = 'processing'
               AND claimed_at < now() - make_interval(secs => %s)
            """,
            (STALE_CLAIM_SECONDS,),
        )
        return cur.rowcount


def claim_next(conn):
    """Claim one pending source, or return None if the queue is empty.

    The SKIP LOCKED subquery is what makes this safe to run in parallel: a
    second worker reaching the same row while this transaction holds it skips
    past to the next candidate instead of blocking on the lock.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE sources
               SET status = 'processing',
                   claimed_at = now(),
                   attempts = attempts + 1
             WHERE id = (
                   SELECT id FROM sources
                    WHERE status = 'pending'
                    ORDER BY uploaded_at
                      FOR UPDATE SKIP LOCKED
                    LIMIT 1
             )
         RETURNING id, filename, content_type, file_data, attempts
            """
        )
        return cur.fetchone()


def _mark_failed(conn, source_id, attempts: int, message: str):
    """Failed for good after MAX_ATTEMPTS, otherwise back on the queue."""
    give_up = attempts >= MAX_ATTEMPTS
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE sources
               SET status = %s, error = %s, claimed_at = NULL
             WHERE id = %s
            """,
            (
                "failed" if give_up else "pending",
                message[:MAX_ERROR_CHARS],
                source_id,
            ),
        )
    verb = "failed" if give_up else f"will retry ({attempts}/{MAX_ATTEMPTS})"
    print(f"  {verb}: {message[:200]}")


def process(conn, row) -> bool:
    """Chunk, embed, and store one claimed source. Returns True on success."""
    source_id, filename, content_type, file_data, attempts = row
    print(f"Ingesting {filename} ({source_id})")

    if file_data is None:
        # Only reachable if a row was queued by something other than the
        # upload endpoint, which always stores the bytes.
        _mark_failed(conn, source_id, MAX_ATTEMPTS, "No file content stored for this source")
        return False

    try:
        pages = extract_pages(filename, content_type, bytes(file_data))
        pending = build_chunks(pages)
    except Exception as exc:  # noqa: BLE001 — any parser failure is the user's to see
        _mark_failed(conn, source_id, attempts, f"Could not read the file: {exc}")
        return False

    if not pending:
        # Not an exception, and worth its own message: a scanned PDF parses
        # perfectly and yields nothing, and "0 chunks" on its own reads like a
        # bug in the pipeline rather than a property of the file.
        _mark_failed(
            conn,
            source_id,
            MAX_ATTEMPTS,
            "No extractable text. If this is a scanned PDF it needs OCR before it "
            "can be searched.",
        )
        return False

    try:
        vectors = embed_batch([chunk for _, chunk in pending])
    except Exception as exc:  # noqa: BLE001
        # Usually the first-run model download failing. Genuinely transient,
        # so this one benefits from the retry.
        _mark_failed(conn, source_id, attempts, f"Embedding failed: {exc}")
        return False

    with conn.cursor() as cur:
        # Clear first, so re-running against a source that already has chunks
        # replaces them instead of stacking a second copy of every chunk —
        # duplicates would skew retrieval toward whatever was ingested twice.
        # This is what makes --requeue and the retry endpoint safe to press.
        cur.execute("DELETE FROM source_chunks WHERE source_id = %s", (source_id,))
        cur.executemany(
            "INSERT INTO source_chunks (id, source_id, text, embedding, page_ref) "
            "VALUES (%s, %s, %s, %s, %s)",
            [
                (str(uuid.uuid4()), source_id, chunk, vector, page_ref)
                for (page_ref, chunk), vector in zip(pending, vectors)
            ],
        )
        cur.execute(
            """
            UPDATE sources
               SET status = 'ready', error = NULL, claimed_at = NULL,
                   ingested_at = now()
             WHERE id = %s
            """,
            (source_id,),
        )

    print(f"  {len(pending)} chunks ready")
    return True


def requeue(conn, study_space_id: str | None) -> int:
    """Put already-ingested sources back on the queue.

    This is the operation the build plan's eval loop needs: changing
    CHUNK_SIZE_CHARS or the embedding model invalidates every vector already
    stored, and the honest way to measure the change is to re-embed the corpus
    and re-run the test cases. Only rows whose bytes were kept can be redone —
    anything ingested through the ingest.py CLI has to be re-run there.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE sources
               SET status = 'pending', error = NULL, attempts = 0, claimed_at = NULL
             WHERE file_data IS NOT NULL
               AND status IN ('ready', 'failed')
               AND (%s::uuid IS NULL OR study_space_id = %s::uuid)
            """,
            (study_space_id, study_space_id),
        )
        return cur.rowcount


def run(once: bool = False):
    # autocommit: each claim, each result, and each reclaim is its own atomic
    # act. Wrapping the loop in one transaction would hold the claim invisible
    # to other workers until the whole batch finished, which defeats the point
    # of claiming a row at a time.
    with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
        idle_logged = False
        while True:
            reclaimed = reclaim_stale(conn)
            if reclaimed:
                print(f"Reclaimed {reclaimed} stale claim(s)")

            row = claim_next(conn)
            if row is not None:
                idle_logged = False
                process(conn, row)
                continue

            if once:
                print("Queue empty.")
                return
            if not idle_logged:
                print(f"Waiting for uploads (polling every {POLL_INTERVAL_SECONDS}s)…")
                idle_logged = True
            time.sleep(POLL_INTERVAL_SECONDS)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--once",
        action="store_true",
        help="process everything pending, then exit instead of polling",
    )
    parser.add_argument(
        "--requeue",
        nargs="?",
        const="__all__",
        metavar="STUDY_SPACE_ID",
        help="re-chunk sources already ingested, optionally in one study space",
    )
    args = parser.parse_args()

    if args.requeue:
        space_id = None if args.requeue == "__all__" else args.requeue
        with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
            count = requeue(conn, space_id)
        scope = "every study space" if space_id is None else f"study space {space_id}"
        print(f"Requeued {count} source(s) in {scope}.")
        if count:
            print("Run `python worker.py --once` to process them.")
        return

    try:
        run(once=args.once)
    except KeyboardInterrupt:
        # A claim held at this moment is left in 'processing' and comes back
        # via reclaim_stale(); nothing is lost, it just waits out the timeout.
        print("\nStopped.")
        sys.exit(0)


if __name__ == "__main__":
    main()
