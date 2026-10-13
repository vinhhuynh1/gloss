"""Guests get a small allowance and stay inside their sandbox; normal users
are untouched. Spending happens in require_quota itself (see
test_guest_usage.py for why), so these tests spend through it."""
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import delete

import demo
from authz import GUEST_LIMITS, require_not_guest, require_quota
from models import AgentRequest, Document, Quiz, StudyGuide, StudySpace, User

VALID_ANCHOR = {"from": {}, "to": {}}


@pytest.fixture
def sandbox(db, world):
    guest = User(id=uuid.uuid4(), email=f"guest-{uuid.uuid4()}@demo.invalid",
                 name="Guest", is_guest=True)
    db.add(guest)
    db.commit()
    # A done guide and quiz on the template, so the copy carries them over.
    db.add_all([
        StudyGuide(document_id=world.doc.id, requested_by=world.alice.id, notes="n",
                   status="done", guide={}),
        Quiz(document_id=world.doc.id, requested_by=world.alice.id, notes="n",
             status="done", questions={}),
    ])
    db.commit()
    space = demo.copy_template(db, world.space.id, guest)
    db.commit()
    doc = db.query(Document).filter_by(study_space_id=space.id).one()
    yield guest, space, doc
    db.rollback()
    db.execute(delete(StudySpace).where(StudySpace.id == space.id))
    db.execute(delete(User).where(User.id == guest.id))
    db.commit()


def _spend(db, guest, kind, n):
    for _ in range(n):
        require_quota(guest, kind, db)
        db.commit()


def test_fifth_check_allowed_sixth_refused(db, sandbox):
    guest, _space, _doc = sandbox
    _spend(db, guest, "check", 4)
    require_quota(guest, "check", db)  # the 5th is fine
    db.commit()
    with pytest.raises(HTTPException) as exc:
        require_quota(guest, "check", db)
    assert exc.value.status_code == 429
    assert exc.value.detail == (
        "Demo limit reached — 5 of 5 checks used. Sign up to keep going."
    )


def test_copied_guide_and_quiz_do_not_count(db, sandbox):
    guest, _space, _doc = sandbox
    require_quota(guest, "study_guide", db)
    require_quota(guest, "quiz", db)


def test_one_new_quiz_then_refused(db, sandbox):
    guest, _space, _doc = sandbox
    _spend(db, guest, "quiz", 1)
    with pytest.raises(HTTPException) as exc:
        require_quota(guest, "quiz", db)
    assert exc.value.status_code == 429


def test_three_chat_questions_then_refused(db, sandbox):
    guest, _space, _doc = sandbox
    _spend(db, guest, "chat", 3)
    with pytest.raises(HTTPException):
        require_quota(guest, "chat", db)


def test_kinds_are_counted_separately(db, sandbox):
    guest, _space, _doc = sandbox
    _spend(db, guest, "check", GUEST_LIMITS["check"][0])
    require_quota(guest, "chat", db)  # checks used up, chat untouched


def test_normal_users_are_never_limited(db, world):
    for _ in range(10):
        require_quota(world.alice, "check", db)
    db.rollback()
    require_not_guest(world.alice, "upload sources")


def test_guest_blocks(sandbox):
    guest, _space, _doc = sandbox
    with pytest.raises(HTTPException) as exc:
        require_not_guest(guest, "upload sources")
    assert exc.value.status_code == 403


def test_endpoints_enforce_the_rules(client, as_user, db, sandbox):
    guest, space, doc = sandbox
    as_user(guest)
    assert client.post("/study-spaces", json={"course_name": "x"}).status_code == 403
    assert client.post(f"/study-spaces/{space.id}/members",
                       json={"email": "a@example.test"}).status_code == 403
    files = {"file": ("x.md", b"# hi", "text/markdown")}
    assert client.post(f"/study-spaces/{space.id}/sources", files=files).status_code == 403
    _spend(db, guest, "check", GUEST_LIMITS["check"][0])
    res = client.post(f"/documents/{doc.id}/agent-requests",
                      json={"passage": "p", "anchor": VALID_ANCHOR})
    assert res.status_code == 429
    assert db.query(AgentRequest).filter_by(requested_by=guest.id).count() == 0
