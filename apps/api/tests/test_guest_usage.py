"""Guest allowance is spent when a request is made, not inferred from rows
that can be deleted — and two requests at once cannot both slip under it."""
import threading
import time
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import delete

import demo
from authz import require_quota
from database import SessionLocal
from models import Document, StudySpace, User


@pytest.fixture
def sandbox(db, world):
    guest = User(id=uuid.uuid4(), email=f"guest-{uuid.uuid4()}@demo.invalid",
                 name="Guest", is_guest=True)
    db.add(guest)
    db.commit()
    space = demo.copy_template(db, world.space.id, guest)
    db.commit()
    doc = db.query(Document).filter_by(study_space_id=space.id).one()
    yield guest, space, doc
    db.rollback()
    db.execute(delete(StudySpace).where(StudySpace.id == space.id))
    db.execute(delete(User).where(User.id == guest.id))
    db.commit()


def test_the_check_itself_spends_the_allowance(db, sandbox):
    guest, _space, _doc = sandbox
    for _ in range(5):
        require_quota(guest, "check", db)
        db.commit()
    with pytest.raises(HTTPException) as exc:
        require_quota(guest, "check", db)
    assert exc.value.status_code == 429


def test_deleting_documents_does_not_reset_the_allowance(db, sandbox):
    guest, _space, doc = sandbox
    require_quota(guest, "study_guide", db)
    db.commit()
    db.execute(delete(Document).where(Document.id == doc.id))
    db.commit()
    with pytest.raises(HTTPException):
        require_quota(guest, "study_guide", db)


def test_a_refused_request_spends_nothing(db, sandbox):
    guest, _space, _doc = sandbox
    require_quota(guest, "quiz", db)
    db.rollback()  # the endpoint failed after the check: nothing was spent
    require_quota(guest, "quiz", db)


def test_parallel_requests_cannot_both_pass(db, sandbox):
    guest, _space, _doc = sandbox
    require_quota(guest, "study_guide", db)  # holds the guest's lock, uncommitted

    outcome = {}

    def second():
        other = SessionLocal()
        try:
            require_quota(guest, "study_guide", other)
            outcome["result"] = "passed"
            other.rollback()
        except HTTPException as exc:
            outcome["result"] = exc.status_code
        finally:
            other.close()

    t = threading.Thread(target=second)
    t.start()
    time.sleep(0.5)
    assert "result" not in outcome  # waiting for the first request's lock
    db.commit()
    t.join(timeout=10)
    assert outcome["result"] == 429
