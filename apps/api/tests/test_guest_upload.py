"""A demo guest may upload one file. Deleting it does not give the upload
back, retrying their own failed upload is free, and signed-up users are not
limited. See docs/superpowers/specs/2026-10-13-demo-upload-and-source-picker-design.md."""
import uuid

import pytest
from sqlalchemy import delete

import demo
from models import Document, GuestUsage, Source, StudySpace, User


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


def _file(name="notes.md"):
    return {"file": (name, b"# Week 1\nTCP handshake.", "text/markdown")}


def _uploads_spent(db, guest):
    return db.query(GuestUsage).filter_by(user_id=guest.id, kind="upload").count()


def test_first_upload_accepted_second_refused(client, as_user, db, sandbox):
    guest, space, _doc = sandbox
    as_user(guest)
    assert client.post(f"/study-spaces/{space.id}/sources", files=_file()).status_code == 202
    res = client.post(f"/study-spaces/{space.id}/sources", files=_file("b.md"))
    assert res.status_code == 429
    assert "1 of 1 uploads used" in res.json()["detail"]
    assert db.query(Source).filter_by(study_space_id=space.id, uploaded_by=guest.id).count() == 1


def test_delete_does_not_refund(client, as_user, db, sandbox):
    guest, space, _doc = sandbox
    as_user(guest)
    created = client.post(f"/study-spaces/{space.id}/sources", files=_file()).json()
    assert client.delete(f"/sources/{created['id']}").status_code == 204
    assert client.post(f"/study-spaces/{space.id}/sources", files=_file()).status_code == 429


def test_refused_file_spends_nothing(client, as_user, db, sandbox):
    guest, space, _doc = sandbox
    as_user(guest)
    bad = {"file": ("x.exe", b"MZ", "application/octet-stream")}
    assert client.post(f"/study-spaces/{space.id}/sources", files=bad).status_code == 415
    empty = {"file": ("x.md", b"", "text/markdown")}
    assert client.post(f"/study-spaces/{space.id}/sources", files=empty).status_code == 400
    assert _uploads_spent(db, guest) == 0


def test_retry_own_failed_upload_is_free(client, as_user, db, sandbox):
    guest, space, _doc = sandbox
    as_user(guest)
    created = client.post(f"/study-spaces/{space.id}/sources", files=_file()).json()
    source = db.get(Source, uuid.UUID(created["id"]))
    source.status = "failed"
    db.commit()
    assert client.post(f"/sources/{created['id']}/retry").status_code == 200
    assert _uploads_spent(db, guest) == 1


def test_guest_cannot_retry_a_copied_template_source(client, as_user, db, world):
    # The copy is stamped uploaded_by = guest and is 'ready': the shape that
    # used to slip past the guard.
    db.add(Source(study_space_id=world.space.id, filename="t.md",
                  uploaded_by=world.alice.id, status="ready",
                  file_data=b"x", content_type="text/markdown", byte_size=1))
    db.commit()
    guest = User(id=uuid.uuid4(), email=f"guest-{uuid.uuid4()}@demo.invalid",
                 name="Guest", is_guest=True)
    db.add(guest)
    db.commit()
    space = demo.copy_template(db, world.space.id, guest)
    db.commit()
    try:
        copied = db.query(Source).filter_by(study_space_id=space.id).one()
        assert copied.uploaded_by == guest.id and copied.status == "ready"
        as_user(guest)
        assert client.post(f"/sources/{copied.id}/retry").status_code == 403
    finally:
        db.rollback()
        db.execute(delete(StudySpace).where(StudySpace.id == space.id))
        db.execute(delete(User).where(User.id == guest.id))
        db.commit()


def test_guest_cannot_retry_their_own_ready_upload(client, as_user, db, sandbox):
    guest, space, _doc = sandbox
    as_user(guest)
    created = client.post(f"/study-spaces/{space.id}/sources", files=_file()).json()
    source = db.get(Source, uuid.UUID(created["id"]))
    source.status = "ready"
    db.commit()
    assert client.post(f"/sources/{created['id']}/retry").status_code == 403


def test_signed_up_users_upload_freely(client, as_user, world):
    as_user(world.alice)
    for name in ("a.md", "b.md", "c.md"):
        res = client.post(f"/study-spaces/{world.space.id}/sources", files=_file(name))
        assert res.status_code == 202


def test_allowance_for_guest(client, as_user, sandbox):
    guest, space, _doc = sandbox
    as_user(guest)
    before = client.get("/me/allowance").json()
    assert before["is_guest"] is True
    assert before["limits"]["upload"] == {"used": 0, "limit": 1}
    client.post(f"/study-spaces/{space.id}/sources", files=_file())
    assert client.get("/me/allowance").json()["limits"]["upload"] == {"used": 1, "limit": 1}


def test_allowance_for_signed_up_user(client, as_user, world):
    as_user(world.alice)
    assert client.get("/me/allowance").json() == {"is_guest": False, "limits": {}}
