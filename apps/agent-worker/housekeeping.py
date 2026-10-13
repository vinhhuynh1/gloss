"""
Housekeeping: deleting expired demo sandboxes.

Its own module rather than part of worker.py, so it can be tested without
loading the embedding model or the Anthropic client.

A guest (users.is_guest, a Supabase anonymous identity) lives for
EXPIRY_HOURS. Deleting the users row is enough: 013_user_delete_cascade.sql
cascades study_spaces.created_by, and the space takes its documents, sources,
chunks and jobs with it. On Supabase the anonymous auth.users row goes too, in
the same transaction, so the auth table does not fill up with dead guests.
The local docker database has no auth schema, so that step is skipped there.
"""
import traceback

import psycopg

EXPIRY_HOURS = 24


def guests_available(conn) -> bool:
    """False until 016_guest_users.sql is applied. The worker then leaves
    housekeeping off rather than crash-looping on a missing column."""
    row = conn.execute(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'is_guest'"
    ).fetchone()
    return row is not None


def _auth_users_present(conn) -> bool:
    return conn.execute("SELECT to_regclass('auth.users') IS NOT NULL").fetchone()[0]


def cleanup_expired_demos(conn) -> int:
    """Delete guests older than EXPIRY_HOURS. Returns how many were removed."""
    with conn.transaction():
        if _auth_users_present(conn):
            conn.execute(
                "DELETE FROM auth.users WHERE is_anonymous "
                "AND created_at < now() - make_interval(hours => %s)",
                (EXPIRY_HOURS,),
            )
        cur = conn.execute(
            "DELETE FROM users WHERE is_guest "
            "AND created_at < now() - make_interval(hours => %s)",
            (EXPIRY_HOURS,),
        )
        return cur.rowcount


def run_once(dsn: str, connect=psycopg.connect) -> int | None:
    """One cleanup on a fresh connection. Never raises: housekeeping is not
    worth stopping the AI lanes for, and a connection held idle for an hour
    between runs would be dropped by a pooler anyway. Returns the number
    removed, or None after logging a failure."""
    try:
        with connect(dsn, autocommit=True) as conn:
            return cleanup_expired_demos(conn)
    except Exception:
        print("[housekeeping] Cleanup failed; will retry next run:")
        traceback.print_exc()
        return None
