"""
The worker: turns uploads into searchable chunks, and answers "check this
passage" requests from the editor.

    python worker.py                      # run forever, processing both queues
    python worker.py --once               # drain both queues and exit
    python worker.py --requeue [space_id] # re-chunk material already ingested

`sources` and `agent_requests` double as the queues. A dedicated broker
(Redis, SQS, Celery) would be the reflex here, but it would be a second piece
of infrastructure to run, deploy, and reason about in exchange for nothing
this workload needs: the volume is a handful of files and questions per study
group, and Postgres is already a hard dependency of every process. `FOR
UPDATE SKIP LOCKED` gives the one property that actually matters — two
workers never claim the same row — in one statement.

Each queue family runs on its own thread (see run()), so a long PDF being
ingested or a study guide being written never holds up a check or a chat
answer that someone is watching.

Run exactly as many of these as you like. Unlike apps/realtime, which must
stay at one replica, this is safely horizontal.
"""
import argparse
import os
import sys
import threading
import time
import uuid
from pathlib import Path

import anthropic
import psycopg
from dotenv import load_dotenv
from psycopg.types.json import Jsonb

import chat
import make_notes
import progress
import quiz
import study_guide
from agent import check_passage, cited_chunk
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

# Much shorter than an upload's: one agent pass is a retrieval query and one
# model call, seconds rather than minutes, and a person is waiting on it. A
# claim this old belongs to a worker that died.
AGENT_STALE_CLAIM_SECONDS = int(os.getenv("AGENT_STALE_CLAIM_SECONDS", "120"))

# A chat answer renews its claim every time it writes streamed text, so this
# measures silence rather than total length: a long answer that is still
# arriving is never reclaimed, and one whose worker died is back on the queue
# this long after its last word. Longer than AGENT_STALE_CLAIM_SECONDS because
# the gap before the first word includes retrieval and the model's thinking.
CHAT_STALE_CLAIM_SECONDS = int(os.getenv("CHAT_STALE_CLAIM_SECONDS", "180"))

# How often a streaming answer is written into its row. The chat polls about
# once a second while an answer is open, so writing much more often than that
# is UPDATEs nobody reads.
CHAT_FLUSH_SECONDS = 0.5


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
        # bug in the pipeline rather than a property of the file. A deck
        # made entirely of pictures of slides is the same case.
        _mark_failed(
            conn,
            source_id,
            MAX_ATTEMPTS,
            "No extractable text. If this is a scanned PDF, or slides made of "
            "images, it needs OCR before it can be searched.",
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


def reclaim_stale_agent_requests(conn) -> int:
    """Same as reclaim_stale, for the agent queue."""
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE agent_requests
               SET status = 'pending', claimed_at = NULL
             WHERE status = 'processing'
               AND claimed_at < now() - make_interval(secs => %s)
            """,
            (AGENT_STALE_CLAIM_SECONDS,),
        )
        return cur.rowcount


def claim_next_agent_request(conn):
    """Claim one pending agent request, or return None.

    Same SKIP LOCKED shape as claim_next. The join to documents is here
    rather than a second query because retrieval is scoped by study space,
    and the request only knows its document.

    A request waits while its own study space has an upload still queued or
    being processed. Otherwise "upload the slides, then check a passage"
    races: checks are claimed first, so the check would run against a space
    with nothing searchable yet and fail with "no material", or quietly
    answer from half the material. Skipping it here, rather than claiming
    and re-queueing it, lets this same loop ingest the upload next instead of
    re-claiming the blocked check forever.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE agent_requests ar
               SET status = 'processing',
                   claimed_at = now(),
                   attempts = ar.attempts + 1
              FROM documents d
             WHERE ar.id = (
                   SELECT r.id
                     FROM agent_requests r
                     JOIN documents rd ON rd.id = r.document_id
                    WHERE r.status = 'pending'
                      AND NOT EXISTS (
                          SELECT 1 FROM sources s
                           WHERE s.study_space_id = rd.study_space_id
                             AND s.status IN ('pending', 'processing')
                      )
                    ORDER BY r.created_at
                      FOR UPDATE OF r SKIP LOCKED
                    LIMIT 1
             )
               AND d.id = ar.document_id
         RETURNING ar.id, ar.document_id, d.study_space_id, ar.passage,
                   ar.anchor, ar.attempts
            """
        )
        return cur.fetchone()


def _fail_agent_request(conn, request_id, attempts: int, message: str, *, retry: bool):
    """Back on the queue if the cause may be transient and attempts remain,
    otherwise failed for good with a message the editor shows as-is."""
    give_up = not retry or attempts >= MAX_ATTEMPTS
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE agent_requests
               SET status = %s, error = %s, claimed_at = NULL,
                   finished_at = CASE WHEN %s THEN now() END
             WHERE id = %s
            """,
            (
                "failed" if give_up else "pending",
                message[:MAX_ERROR_CHARS],
                give_up,
                request_id,
            ),
        )
    verb = "failed" if give_up else f"will retry ({attempts}/{MAX_ATTEMPTS})"
    print(f"  {verb}: {message[:200]}")


def _describe_agent_error(exc: Exception) -> tuple[str, bool]:
    """(message for the editor, worth retrying?)

    Rate limits, overloads, server errors, and dropped connections pass on
    their own — the SDK has already retried twice by the time one reaches
    here, and one more go under MAX_ATTEMPTS is cheap. Any other 4xx will be
    rejected identically every time, so it fails straight away rather than
    spending two more model calls to prove it.
    """
    if isinstance(exc, TypeError) and "authentication" in str(exc):
        # No key anywhere the SDK looks. It raises this at request time, not
        # at construction, as a TypeError rather than an API error, and it
        # will be identical on every retry.
        return (
            "The agent worker has no Anthropic credentials. Set ANTHROPIC_API_KEY "
            "in apps/agent-worker/.env and restart it.",
            False,
        )
    if isinstance(exc, anthropic.APIConnectionError):
        return "Could not reach the AI service.", True
    if isinstance(exc, anthropic.AuthenticationError):
        return "The agent worker's ANTHROPIC_API_KEY was rejected.", False
    if isinstance(exc, anthropic.APIStatusError):
        transient = exc.status_code == 429 or exc.status_code >= 500
        return f"The AI service returned an error (HTTP {exc.status_code}).", transient
    return f"The check failed: {exc}", True


class _ClaimLost(Exception):
    """Raised inside the result transaction to roll it back."""


def process_agent_request(conn, row) -> bool:
    """Run the agent on one claimed request. Returns True on success."""
    request_id, document_id, study_space_id, passage, anchor, attempts = row
    print(f"Checking passage for request {request_id}")

    try:
        result, chunks = check_passage(str(study_space_id), passage)
    except Exception as exc:  # noqa: BLE001 — every failure is the requester's to see
        message, retry = _describe_agent_error(exc)
        _fail_agent_request(conn, request_id, attempts, message, retry=retry)
        return False

    if result is None:
        _fail_agent_request(
            conn,
            request_id,
            attempts,
            "This study space has no searchable material yet. Upload course "
            "material first, and wait for it to finish processing.",
            retry=False,
        )
        return False

    # The suggestion and the request's outcome commit together. Separately, a
    # crash between them would leave a suggestion whose request goes back on
    # the queue — and the retry would write a second copy of it.
    try:
        with conn.transaction():
            with conn.cursor() as cur:
                suggestion_id = None
                if result["type"] != "none":
                    chunk = cited_chunk(result, chunks)
                    cur.execute(
                        """
                        INSERT INTO suggestions
                               (id, document_id, type, anchor, proposed_text,
                                source_chunk_id, source_filename, source_page_ref,
                                source_excerpt)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                        RETURNING id
                        """,
                        (
                            str(uuid.uuid4()),
                            document_id,
                            result["type"],
                            Jsonb(anchor),
                            result["proposed_text"],
                            result.get("source_chunk_id"),
                            chunk["filename"] if chunk else None,
                            chunk["page_ref"] if chunk else None,
                            chunk["text"] if chunk else None,
                        ),
                    )
                    suggestion_id = cur.fetchone()[0]

                # `attempts` is this claim's token: every claim increments it,
                # so a match means no other worker has reclaimed the row since
                # we took it. On a mismatch the whole transaction rolls back
                # and the other worker's answer stands.
                cur.execute(
                    """
                    UPDATE agent_requests
                       SET status = 'done', result_type = %s, reasoning = %s,
                           suggestion_id = %s, error = NULL, claimed_at = NULL,
                           finished_at = now()
                     WHERE id = %s AND attempts = %s
                    """,
                    (
                        result["type"],
                        result.get("reasoning"),
                        suggestion_id,
                        request_id,
                        attempts,
                    ),
                )
                if cur.rowcount == 0:
                    raise _ClaimLost()
    except _ClaimLost:
        print("  claim was reclaimed by another worker; discarding this result")
        return False

    print(f"  verdict: {result['type']}")
    return True


def study_guides_available(conn) -> bool:
    """Does the study_guides table exist yet?

    Checked once at startup so that a deploy which got ahead of its migration
    costs the study-guide queue and nothing else. That ordering is ordinary —
    Railway redeploys on a merge to main, and infra/migrations is applied by
    hand — and the first time it happened an UndefinedTable raised out of
    reclaim_stale_study_guides, out of run(), and crash-looped the worker every
    seven seconds. Uploads stopped being chunked and Check with AI stopped
    answering, for a queue that had no rows in it and a feature nobody could
    reach yet.

    Not a try/except around the loop body: that would swallow a dropped
    connection, a permissions problem and a genuine bug alike, and turn each
    into a hot spin. This fails in exactly one known way and names the fix.
    """
    with conn.cursor() as cur:
        cur.execute("SELECT to_regclass('public.study_guides') IS NOT NULL")
        return bool(cur.fetchone()[0])


def quizzes_available(conn) -> bool:
    """Does the quizzes table exist yet?

    The same guard as study_guides_available, for the same reason and with the
    same history: 005 was merged before it was applied and the worker
    crash-looped until someone noticed. Checked once at startup so a deploy
    that gets ahead of 014 costs the quiz queue and nothing else.
    """
    with conn.cursor() as cur:
        cur.execute("SELECT to_regclass('public.quizzes') IS NOT NULL")
        return bool(cur.fetchone()[0])


def progress_available(conn) -> bool:
    """Do study_guides and quizzes have the progress columns?

    Checked once at startup, like the table guards above. Without them the
    worker writes guides and quizzes exactly as before, just with no progress
    for the editor to show — a deploy ahead of its migration costs the bar
    and nothing else.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT count(*) FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name IN ('study_guides', 'quizzes')
               AND column_name IN ('progress', 'stage')
            """
        )
        return cur.fetchone()[0] == 4


# Set by run() from progress_available(). Module-level because the process_*
# functions are also called directly by tests, which never run the check.
_progress_on = False

# One write a second at most. The editor polls every two.
PROGRESS_WRITE_SECONDS = 1.0

_PROGRESS_TABLES = ("study_guides", "quizzes")


def _progress_reporter(conn, table: str, row_id, attempts: int) -> progress.Report:
    """A progress.Report that writes to this claimed row.

    Each write also renews claimed_at: a long guide on a slow model is still
    being worked on, and should not look stale to another worker's sweep.
    Guarded by the claim token like every other write, and silent when the
    columns are missing.
    """
    assert table in _PROGRESS_TABLES  # interpolated below; never user input
    last = {"at": 0.0, "stage": None, "percent": -1}

    def report(stage: str, percent: int) -> None:
        if not _progress_on:
            return
        now = time.monotonic()
        changed_stage = stage != last["stage"]
        if not changed_stage and (
            percent <= last["percent"] or now - last["at"] < PROGRESS_WRITE_SECONDS
        ):
            return
        last.update(at=now, stage=stage, percent=percent)
        with conn.cursor() as cur:
            cur.execute(
                f"""
                UPDATE {table}
                   SET progress = %s, stage = %s, claimed_at = now()
                 WHERE id = %s AND attempts = %s AND status = 'processing'
                """,
                (max(0, min(99, percent)), stage, row_id, attempts),
            )

    return report


def reclaim_stale_quizzes(conn) -> int:
    """Same as reclaim_stale, for the quiz queue."""
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE quizzes
               SET status = 'pending', claimed_at = NULL
             WHERE status = 'processing'
               AND claimed_at < now() - make_interval(secs => %s)
            """,
            (AGENT_STALE_CLAIM_SECONDS,),
        )
        return cur.rowcount


def claim_next_quiz(conn):
    """Claim one pending quiz, or return None.

    Same shape as claim_next_study_guide, including the wait on unsettled
    uploads: a quiz written while half the slides are still being chunked
    would silently cover half the course, and nothing about the finished quiz
    would say so.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE quizzes qz
               SET status = 'processing',
                   claimed_at = now(),
                   attempts = qz.attempts + 1
              FROM documents d
             WHERE qz.id = (
                   SELECT q.id
                     FROM quizzes q
                     JOIN documents qd ON qd.id = q.document_id
                    WHERE q.status = 'pending'
                      AND NOT EXISTS (
                          SELECT 1 FROM sources s
                           WHERE s.study_space_id = qd.study_space_id
                             AND s.status IN ('pending', 'processing')
                      )
                    ORDER BY q.created_at
                      FOR UPDATE OF q SKIP LOCKED
                    LIMIT 1
             )
               AND d.id = qz.document_id
         RETURNING qz.id, d.study_space_id, qz.notes, qz.attempts
            """
        )
        return cur.fetchone()


def _fail_quiz(conn, quiz_id, attempts: int, message: str, *, retry: bool):
    """Mirror of _fail_study_guide for the quiz queue."""
    give_up = not retry or attempts >= MAX_ATTEMPTS
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE quizzes
               SET status = %s, error = %s, claimed_at = NULL,
                   finished_at = CASE WHEN %s THEN now() END
            WHERE id = %s
            """,
            ("failed" if give_up else "pending", message[:MAX_ERROR_CHARS], give_up, quiz_id),
        )
    verb = "failed" if give_up else f"will retry ({attempts}/{MAX_ATTEMPTS})"
    print(f"  {verb}: {message[:200]}")


def process_quiz(conn, row) -> bool:
    """Write one quiz for a claimed row. Returns True on success."""
    quiz_id, study_space_id, notes, attempts = row
    print(f"Writing quiz {quiz_id}")
    report = _progress_reporter(conn, "quizzes", quiz_id, attempts)
    report(progress.STAGE_STARTING, 2)

    try:
        result, _chunks = quiz.generate(str(study_space_id), notes, report)
    except study_guide.EmptyNotesError as exc:
        # Nothing to write from, and nothing a retry would change.
        _fail_quiz(conn, quiz_id, attempts, str(exc), retry=False)
        return False
    except Exception as exc:  # noqa: BLE001 — every failure is the requester's to see
        message, retry = _describe_agent_error(exc)
        _fail_quiz(conn, quiz_id, attempts, message, retry=retry)
        return False

    if not result["questions"]:
        # Every question cited an excerpt it was never given or came back
        # malformed, so _validate_quiz dropped them all. One retry is worth
        # it — this is a bad sample, not a bad document.
        _fail_quiz(
            conn,
            quiz_id,
            attempts,
            "No questions could be grounded in your sources.",
            retry=True,
        )
        return False

    # `attempts` is this claim's token, exactly as in process_study_guide.
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE quizzes
               SET status = 'done', questions = %s, error = NULL, claimed_at = NULL,
                   finished_at = now()
             WHERE id = %s AND attempts = %s
            """,
            (Jsonb(result), quiz_id, attempts),
        )
        if cur.rowcount == 0:
            print("  claim was reclaimed by another worker; discarding this result")
            return False

    print(f"  {len(result['questions'])} questions")
    return True


def chat_available(conn) -> bool:
    """Does the chat_messages table exist yet? The same startup guard as
    study_guides_available, for the same reason: a deploy that gets ahead of
    009 costs the chat queue and nothing else."""
    with conn.cursor() as cur:
        cur.execute("SELECT to_regclass('public.chat_messages') IS NOT NULL")
        return bool(cur.fetchone()[0])


def reclaim_stale_chat(conn) -> int:
    """Same as reclaim_stale, for chat answers. The half-written body goes
    too: the retry starts the answer again from nothing, and leaving the old
    start on screen until the new one overwrites it would read as two answers
    spliced together."""
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE chat_messages
               SET status = 'pending', claimed_at = NULL, body = '',
                   updated_at = clock_timestamp()
             WHERE status = 'processing'
               AND claimed_at < now() - make_interval(secs => %s)
            """,
            (CHAT_STALE_CLAIM_SECONDS,),
        )
        return cur.rowcount


def claim_next_chat_answer(conn):
    """Claim one pending answer, or return None.

    Same SKIP LOCKED shape as claim_next_agent_request, including the wait on
    unsettled uploads: "drop the slides in, then ask about them" is the
    ordinary way to use the chat, and answering before the slides are chunked
    would answer from nothing.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE chat_messages cm
               SET status = 'processing',
                   claimed_at = now(),
                   attempts = cm.attempts + 1,
                   updated_at = clock_timestamp()
             WHERE cm.id = (
                   SELECT a.id
                     FROM chat_messages a
                    WHERE a.status = 'pending'
                      AND a.role = 'assistant'
                      AND NOT EXISTS (
                          SELECT 1 FROM sources s
                           WHERE s.study_space_id = a.study_space_id
                             AND s.status IN ('pending', 'processing')
                      )
                    ORDER BY a.created_at
                      FOR UPDATE OF a SKIP LOCKED
                    LIMIT 1
             )
         RETURNING cm.id, cm.study_space_id, cm.reply_to, cm.attempts,
                   cm.kind, cm.source_ids, cm.context, cm.outline
            """
        )
        return cur.fetchone()


def _fail_chat_answer(conn, answer_id, attempts: int, message: str, *, retry: bool):
    """Mirror of _fail_agent_request for chat answers. The partial body is
    cleared on both paths, for the reason given on reclaim_stale_chat."""
    give_up = not retry or attempts >= MAX_ATTEMPTS
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE chat_messages
               SET status = %s, error = %s, body = '', claimed_at = NULL,
                   finished_at = CASE WHEN %s THEN now() END,
                   updated_at = clock_timestamp()
             WHERE id = %s AND attempts = %s
            """,
            (
                "failed" if give_up else "pending",
                message[:MAX_ERROR_CHARS],
                give_up,
                answer_id,
                attempts,
            ),
        )
    verb = "failed" if give_up else f"will retry ({attempts}/{MAX_ATTEMPTS})"
    print(f"  {verb}: {message[:200]}")


def _load_chat_thread(conn, question_id):
    """(question body, asker's name, earlier finished messages oldest first),
    or None if the question is gone.

    Only finished messages go into the history: a failed answer has no body,
    and another answer still streaming in the same space is half a sentence.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT q.body, u.name, q.study_space_id, q.created_at
              FROM chat_messages q
              LEFT JOIN users u ON u.id = q.author_id
             WHERE q.id = %s
            """,
            (question_id,),
        )
        row = cur.fetchone()
        if row is None:
            return None
        body, name, space_id, created_at = row
        cur.execute(
            """
            SELECT m.role, u.name, m.body
              FROM chat_messages m
              LEFT JOIN users u ON u.id = m.author_id
             WHERE m.study_space_id = %s
               AND m.created_at < %s
               AND m.status = 'done'
             ORDER BY m.created_at DESC
             LIMIT %s
            """,
            (space_id, created_at, chat.HISTORY_MESSAGES),
        )
        history = list(reversed(cur.fetchall()))
    return body, name, history


def _load_note_files(conn, study_space_id, source_ids):
    """[(filename, [(page_ref, text)])] for a notes request, in the order the
    files were asked for.

    The original upload is re-parsed when there is one, which gives pages in
    true reading order. A source ingested from the command line stored no
    file, and falls back to its chunks in physical (insertion) order:
    source_chunks has no position column, but chunks are written once in
    order and never updated, so ctid order is the order they were written.

    Sources that are gone or failed are skipped rather than failing the whole
    request; if none are left, the caller says so.
    """
    files = []
    with conn.cursor() as cur:
        for source_id in source_ids or []:
            cur.execute(
                """
                SELECT filename, content_type, file_data
                  FROM sources
                 WHERE id = %s AND study_space_id = %s AND status = 'ready'
                """,
                (source_id, study_space_id),
            )
            row = cur.fetchone()
            if row is None:
                continue
            filename, content_type, file_data = row
            if file_data is not None:
                pages = make_notes.pages_from_file(filename, content_type, bytes(file_data))
            else:
                cur.execute(
                    "SELECT page_ref, text FROM source_chunks WHERE source_id = %s ORDER BY ctid",
                    (source_id,),
                )
                pages = make_notes.pages_from_chunks(cur.fetchall())
            files.append((filename, pages))
    return files


def process_chat_answer(conn, row) -> bool:
    """Stream one answer into its row. Returns True on success."""
    (answer_id, study_space_id, question_id, attempts,
     kind, source_ids, context, outline) = row
    verb = {"notes": "Writing notes for", "plan": "Planning notes for"}.get(kind, "Answering")
    print(f"{verb} chat question {question_id}")

    thread = _load_chat_thread(conn, question_id)
    if thread is None:
        _fail_chat_answer(conn, answer_id, attempts, "The question was deleted.", retry=False)
        return False
    question, author, history = thread

    streamed: list[str] = []
    last_flush = time.monotonic()

    def write_body(body: str) -> None:
        # `attempts` is the claim token, as everywhere else. A write that
        # matches nothing means another worker reclaimed the row, and the
        # rest of this stream is money spent on an answer nobody will see.
        # Every write also renews claimed_at, which is what keeps a long
        # answer from being reclaimed while it is still arriving.
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE chat_messages
                   SET body = %s, claimed_at = now(), updated_at = clock_timestamp()
                 WHERE id = %s AND attempts = %s AND status = 'processing'
                """,
                (body, answer_id, attempts),
            )
            if cur.rowcount == 0:
                raise _ClaimLost()

    def on_text(text: str) -> None:
        nonlocal last_flush
        streamed.append(text)
        if time.monotonic() - last_flush < CHAT_FLUSH_SECONDS:
            return
        last_flush = time.monotonic()
        write_body("".join(streamed))

    def on_progress(status_line: str) -> None:
        # Shown in place of the answer until the notes themselves start
        # arriving. Reading a long book in parts streams nothing, and a
        # "Thinking…" that lasts two minutes looks like a hang.
        if not streamed:
            write_body(f"_{status_line}_")

    planned = None
    try:
        if kind in ("notes", "plan"):
            files = _load_note_files(conn, study_space_id, source_ids)
            if not files:
                raise make_notes.NotesError(
                    "Those files are no longer in this space, or could not be read."
                )
        if kind == "plan":
            on_progress("Reading the files to plan the notes…")
            planned = make_notes.plan(files, question, context or "")
            body, citations = make_notes.plan_as_text(planned), []
        elif kind == "notes":
            body, citations = make_notes.generate(
                files, question, context or "", on_text, on_progress, outline=outline
            )
            if not make_notes.has_notes(body, citations):
                # "Your notes already cover this" — a reply, not notes. Stored
                # as an ordinary answer so nothing offers to insert it, and an
                # auto or plan request does not insert it by itself.
                kind = "answer"
        else:
            body, citations = chat.answer(
                str(study_space_id), history, author or "A member", question, on_text
            )
    except _ClaimLost:
        print("  claim was reclaimed by another worker; abandoning this answer")
        return False
    except make_notes.NotesError as exc:
        _fail_chat_answer(conn, answer_id, attempts, str(exc), retry=False)
        return False
    except chat.Declined as exc:
        _fail_chat_answer(conn, answer_id, attempts, str(exc), retry=False)
        return False
    except (anthropic.APIError, TypeError) as exc:
        message, retry = _describe_agent_error(exc)
        _fail_chat_answer(conn, answer_id, attempts, message, retry=retry)
        return False
    except Exception as exc:  # noqa: BLE001 — every failure is the asker's to see
        _fail_chat_answer(conn, answer_id, attempts, f"The answer failed: {exc}", retry=True)
        return False

    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE chat_messages
               SET status = 'done', body = %s, citations = %s, error = NULL,
                   outline = COALESCE(%s, outline), kind = %s,
                   claimed_at = NULL, finished_at = now(),
                   updated_at = clock_timestamp()
             WHERE id = %s AND attempts = %s
            """,
            (
                body,
                Jsonb(citations),
                Jsonb(planned) if planned is not None else None,
                kind,
                answer_id,
                attempts,
            ),
        )
        if cur.rowcount == 0:
            print("  claim was reclaimed by another worker; discarding this answer")
            return False

    print(f"  {len(body)} chars, {len(citations)} citation(s)")
    return True


def reclaim_stale_study_guides(conn) -> int:
    """Same as reclaim_stale, for the study-guide queue."""
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE study_guides
               SET status = 'pending', claimed_at = NULL
             WHERE status = 'processing'
               AND claimed_at < now() - make_interval(secs => %s)
            """,
            (AGENT_STALE_CLAIM_SECONDS,),
        )
        return cur.rowcount


def claim_next_study_guide(conn):
    """Claim one pending study guide, or return None.

    Same shape as claim_next_agent_request, including the wait on unsettled
    uploads: a guide generated while half the slides are still being chunked
    would silently cover half the course, which is worse than waiting because
    nothing about the finished guide would say so.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE study_guides sg
               SET status = 'processing',
                   claimed_at = now(),
                   attempts = sg.attempts + 1
              FROM documents d
             WHERE sg.id = (
                   SELECT g.id
                     FROM study_guides g
                     JOIN documents gd ON gd.id = g.document_id
                    WHERE g.status = 'pending'
                      AND NOT EXISTS (
                          SELECT 1 FROM sources s
                           WHERE s.study_space_id = gd.study_space_id
                             AND s.status IN ('pending', 'processing')
                      )
                    ORDER BY g.created_at
                      FOR UPDATE OF g SKIP LOCKED
                    LIMIT 1
             )
               AND d.id = sg.document_id
         RETURNING sg.id, d.study_space_id, sg.notes, sg.attempts
            """
        )
        return cur.fetchone()


def _fail_study_guide(conn, guide_id, attempts: int, message: str, *, retry: bool):
    """Mirror of _fail_agent_request for the guide queue."""
    give_up = not retry or attempts >= MAX_ATTEMPTS
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE study_guides
               SET status = %s, error = %s, claimed_at = NULL,
                   finished_at = CASE WHEN %s THEN now() END
             WHERE id = %s
            """,
            ("failed" if give_up else "pending", message[:MAX_ERROR_CHARS], give_up, guide_id),
        )
    verb = "failed" if give_up else f"will retry ({attempts}/{MAX_ATTEMPTS})"
    print(f"  {verb}: {message[:200]}")


def process_study_guide(conn, row) -> bool:
    """Generate one guide for a claimed row. Returns True on success."""
    guide_id, study_space_id, notes, attempts = row
    print(f"Writing study guide {guide_id}")
    report = _progress_reporter(conn, "study_guides", guide_id, attempts)
    report(progress.STAGE_STARTING, 2)

    try:
        guide, _chunks = study_guide.generate(str(study_space_id), notes, report)
    except study_guide.EmptyNotesError as exc:
        # Nothing to write from, and nothing a retry would change.
        _fail_study_guide(conn, guide_id, attempts, str(exc), retry=False)
        return False
    except Exception as exc:  # noqa: BLE001 — every failure is the requester's to see
        message, retry = _describe_agent_error(exc)
        _fail_study_guide(conn, guide_id, attempts, message, retry=retry)
        return False

    if not guide["sections"]:
        # Every point the model wrote cited an excerpt it was never given, so
        # _validate_guide dropped them all. Retrying is worth one go — this is
        # a bad sample, not a bad document.
        _fail_study_guide(
            conn,
            guide_id,
            attempts,
            "The guide came back with nothing that could be traced to your "
            "source material, so it was discarded rather than shown.",
            retry=True,
        )
        return False

    # `attempts` is this claim's token, exactly as in process_agent_request.
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE study_guides
               SET status = 'done', guide = %s, error = NULL, claimed_at = NULL,
                   finished_at = now()
             WHERE id = %s AND attempts = %s
            """,
            (Jsonb(guide), guide_id, attempts),
        )
        if cur.rowcount == 0:
            print("  claim was reclaimed by another worker; discarding this result")
            return False

    points = sum(len(s["points"]) for s in guide["sections"])
    print(f"  {len(guide['sections'])} sections, {points} points, "
          f"{len(guide['key_terms'])} key terms")
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


INTERACTIVE_POLL_SECONDS = float(os.getenv("INTERACTIVE_POLL_SECONDS", "0.5"))


def _lane(name: str, jobs, poll: float, once: bool, stop: threading.Event) -> None:
    """One queue family on its own thread and its own connection.

    jobs is [(reclaim, claim, process)]. Claimed in the order given, and the
    lane goes back to the top after every job, so the first queue in a lane
    keeps its priority over the rest of that lane.

    autocommit: each claim, each result, and each reclaim is its own atomic
    act. Wrapping the loop in one transaction would hold the claim invisible
    to other workers until the whole batch finished, which defeats the point
    of claiming a row at a time.
    """
    try:
        with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
            while not stop.is_set():
                reclaimed = sum(reclaim(conn) for reclaim, _claim, _process in jobs)
                if reclaimed:
                    print(f"[{name}] Reclaimed {reclaimed} stale claim(s)")

                for _reclaim, claim, process_row in jobs:
                    row = claim(conn)
                    if row is not None:
                        process_row(conn, row)
                        break
                else:
                    if once:
                        return
                    stop.wait(poll)
    except Exception:
        # A lane that dies takes its queues with it; stop the rest so the
        # process exits and the platform restarts it, rather than running on
        # half-deaf with nothing in the log but this.
        stop.set()
        raise


def run(once: bool = False):
    """Each queue family gets its own lane, so a study guide that takes a
    minute no longer holds up a chat answer, a check, or a quiz queued behind
    it. Claims are FOR UPDATE SKIP LOCKED throughout, which is what already
    made running several workers safe; lanes are the same thing in-process.
    """
    with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
        guides_on = study_guides_available(conn)
        if not guides_on:
            print("WARNING: no study_guides table — study guides are OFF "
                  "for this process.")
            print("         Apply infra/migrations/005_study_guides.sql, re-run")
            print("         infra/supabase/011_lockdown.sql on Supabase, then")
            print("         restart this worker. Uploads and checks are "
                  "unaffected.")

        chat_on = chat_available(conn)
        if not chat_on:
            print("WARNING: no chat_messages table — the space chat is OFF "
                  "for this process.")
            print("         Apply infra/migrations/009_chat.sql, re-run")
            print("         infra/supabase/011_lockdown.sql on Supabase, then")
            print("         restart this worker. Everything else is "
                  "unaffected.")

        # Set before any lane starts and only read after, so the lanes share
        # it without a lock.
        global _progress_on
        _progress_on = progress_available(conn)
        if not _progress_on:
            print("NOTE: no progress columns on study_guides/quizzes — "
                  "guides and quizzes run without a progress bar. Apply")
            print("      infra/migrations/012_generation_progress.sql and "
                  "restart this worker to turn it on.")

        quizzes_on = quizzes_available(conn)
        if not quizzes_on:
            print("WARNING: no quizzes table — quizzes are OFF "
                  "for this process.")
            print("         Apply infra/migrations/014_quizzes.sql, re-run")
            print("         infra/supabase/011_lockdown.sql on Supabase, then")
            print("         restart this worker. Everything else is "
                  "unaffected.")

    # Checks first within the interactive lane: someone is waiting on each,
    # and they are shorter than a chat answer.
    interactive = [
        (reclaim_stale_agent_requests, claim_next_agent_request, process_agent_request)
    ]
    if chat_on:
        interactive.append((reclaim_stale_chat, claim_next_chat_answer, process_chat_answer))

    lanes = [
        ("interactive", interactive, INTERACTIVE_POLL_SECONDS),
        ("uploads", [(reclaim_stale, claim_next, process)], POLL_INTERVAL_SECONDS),
    ]
    if guides_on:
        lanes.append((
            "guides",
            [(reclaim_stale_study_guides, claim_next_study_guide, process_study_guide)],
            POLL_INTERVAL_SECONDS,
        ))
    if quizzes_on:
        lanes.append((
            "quizzes",
            [(reclaim_stale_quizzes, claim_next_quiz, process_quiz)],
            POLL_INTERVAL_SECONDS,
        ))

    stop = threading.Event()
    threads = [
        threading.Thread(
            target=_lane, args=(name, jobs, poll, once, stop), name=name, daemon=True
        )
        for name, jobs, poll in lanes
    ]
    for thread in threads:
        thread.start()

    if not once:
        names = ", ".join(name for name, _jobs, _poll in lanes)
        off = [
            name
            for name, on in (("chat", chat_on), ("guides", guides_on), ("quizzes", quizzes_on))
            if not on
        ]
        suffix = f" ({', '.join(off)} OFF)" if off else ""
        print(f"Waiting for work on {len(lanes)} lanes: {names}{suffix}…")

    try:
        # join with a timeout so Ctrl-C reaches the main thread on Windows.
        while any(t.is_alive() for t in threads):
            for thread in threads:
                thread.join(timeout=0.5)
    except KeyboardInterrupt:
        stop.set()
        raise

    if once:
        print("Queue empty.")
    elif stop.is_set():
        sys.exit("A worker lane stopped unexpectedly; see the traceback above.")


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
