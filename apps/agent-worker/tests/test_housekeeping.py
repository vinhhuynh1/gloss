"""Expired guests and their sandboxes go; everyone else stays."""
import os
import uuid

import psycopg
import pytest
from dotenv import load_dotenv

import housekeeping

load_dotenv()
DATABASE_URL = os.environ["DATABASE_URL"]


@pytest.fixture
def conn():
    with psycopg.connect(DATABASE_URL, autocommit=True) as c:
        yield c


def _user(conn, *, guest: bool, age_hours: float) -> uuid.UUID:
    uid = uuid.uuid4()
    conn.execute(
        "INSERT INTO users (id, email, name, is_guest, created_at) "
        "VALUES (%s, %s, 'T', %s, now() - make_interval(secs => %s))",
        (uid, f"hk-{uid}@example.test", guest, age_hours * 3600),
    )
    return uid


def _space(conn, owner: uuid.UUID) -> uuid.UUID:
    sid = uuid.uuid4()
    conn.execute(
        "INSERT INTO study_spaces (id, course_name, created_by, is_demo) "
        "VALUES (%s, 'x', %s, true)",
        (sid, owner),
    )
    return sid


def _exists(conn, table: str, row_id: uuid.UUID) -> bool:
    return conn.execute(f"SELECT 1 FROM {table} WHERE id = %s", (row_id,)).fetchone() is not None


def test_guests_available(conn):
    assert housekeeping.guests_available(conn) is True


def test_cleanup_removes_only_expired_guests(conn):
    old_guest = _user(conn, guest=True, age_hours=25)
    new_guest = _user(conn, guest=True, age_hours=1)
    old_person = _user(conn, guest=False, age_hours=500)
    old_space = _space(conn, old_guest)
    new_space = _space(conn, new_guest)
    try:
        removed = housekeeping.cleanup_expired_demos(conn)
        assert removed >= 1
        assert not _exists(conn, "users", old_guest)
        assert not _exists(conn, "study_spaces", old_space)
        assert _exists(conn, "users", new_guest)
        assert _exists(conn, "study_spaces", new_space)
        assert _exists(conn, "users", old_person)
    finally:
        conn.execute("DELETE FROM study_spaces WHERE id = ANY(%s)", ([old_space, new_space],))
        conn.execute("DELETE FROM users WHERE id = ANY(%s)", ([old_guest, new_guest, old_person],))


def test_cleanup_without_auth_schema_does_not_fail(conn):
    # The local docker database has no auth schema; cleanup must skip it.
    assert isinstance(housekeeping.cleanup_expired_demos(conn), int)


def test_run_once_survives_a_failure():
    def broken_connect(*_args, **_kwargs):
        raise RuntimeError("permission denied for table users")

    # Must return rather than raise: a cleanup failure must not stop the
    # worker's AI lanes.
    assert housekeeping.run_once(DATABASE_URL, connect=broken_connect) is None


def test_run_once_cleans_up_with_its_own_connection():
    assert isinstance(housekeeping.run_once(DATABASE_URL), int)
