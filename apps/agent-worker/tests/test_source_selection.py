"""Retrieval and the claim wait narrow to the chosen sources."""
import os
import uuid

import psycopg
import pytest
from dotenv import load_dotenv

import retrieval
import worker

load_dotenv()
DATABASE_URL = os.environ["DATABASE_URL"]
VEC = [1.0] + [0.0] * 383


@pytest.fixture
def conn():
    with psycopg.connect(DATABASE_URL, autocommit=True) as c:
        yield c


@pytest.fixture
def space(conn):
    uid, sid, did = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    conn.execute("INSERT INTO users (id, email, name) VALUES (%s, %s, 'T')",
                 (uid, f"sel-{uid}@example.test"))
    conn.execute("INSERT INTO study_spaces (id, course_name, created_by) VALUES (%s, 'x', %s)",
                 (sid, uid))
    conn.execute("INSERT INTO documents (id, study_space_id, title) VALUES (%s, %s, 'd')",
                 (did, sid))
    yield uid, sid, did
    conn.execute("DELETE FROM study_spaces WHERE id = %s", (sid,))
    conn.execute("DELETE FROM users WHERE id = %s", (uid,))


def _source(conn, uid, sid, status="ready", chunk=True):
    src = uuid.uuid4()
    conn.execute(
        "INSERT INTO sources (id, study_space_id, filename, uploaded_by, status) "
        "VALUES (%s, %s, %s, %s, %s)",
        (src, sid, f"{src}.md", uid, status),
    )
    if chunk:
        conn.execute(
            "INSERT INTO source_chunks (id, source_id, text, embedding) VALUES (%s, %s, 't', %s)",
            (uuid.uuid4(), src, str(VEC)),
        )
    return src


def test_query_without_selection_searches_the_space(conn, space):
    uid, sid, _ = space
    a, b = _source(conn, uid, sid), _source(conn, uid, sid)
    rows = retrieval._query(conn, str(sid), VEC, 10)
    assert {r["filename"] for r in rows} == {f"{a}.md", f"{b}.md"}


def test_query_with_selection_searches_only_those(conn, space):
    uid, sid, _ = space
    a, _b = _source(conn, uid, sid), _source(conn, uid, sid)
    rows = retrieval._query(conn, str(sid), VEC, 10, source_ids=[str(a)])
    assert {r["filename"] for r in rows} == {f"{a}.md"}


def _guide(conn, uid, did, source_ids):
    gid = uuid.uuid4()
    # Backdated so it is the oldest pending guide and the one claimed.
    conn.execute(
        "INSERT INTO study_guides (id, document_id, requested_by, notes, status, attempts, "
        "source_ids, created_at) VALUES (%s, %s, %s, 'n', 'pending', 0, %s, '2000-01-01')",
        (gid, did, uid, source_ids),
    )
    return gid


def test_claim_waits_only_on_chosen_sources(conn, space):
    uid, sid, did = space
    ready = _source(conn, uid, sid)
    _source(conn, uid, sid, status="processing", chunk=False)
    gid = _guide(conn, uid, did, [ready])
    row = worker.claim_next_study_guide(conn)
    assert row is not None and row[0] == gid
    assert [str(x) for x in row[4]] == [str(ready)]


def test_claim_still_waits_when_a_chosen_source_is_processing(conn, space):
    uid, sid, did = space
    busy = _source(conn, uid, sid, status="processing", chunk=False)
    gid = _guide(conn, uid, did, [busy])
    row = worker.claim_next_study_guide(conn)
    assert row is None or row[0] != gid


def test_claim_ignores_deleted_chosen_source(conn, space):
    # Review Focus 2: a chosen source deleted after the request must not
    # hold the guide back.
    uid, sid, did = space
    ready = _source(conn, uid, sid)
    gid = _guide(conn, uid, did, [ready, uuid.uuid4()])
    row = worker.claim_next_study_guide(conn)
    assert row is not None and row[0] == gid
