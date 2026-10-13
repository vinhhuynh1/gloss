"""POST /demo: guests only, idempotent, capped, and off without a template."""
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
from sqlalchemy import delete, func, select

from models import StudySpace, User

BUSY = "The demo is busy right now — try again tomorrow."


@pytest.fixture
def guest(db):
    user = User(id=uuid.uuid4(), email=f"guest-{uuid.uuid4()}@demo.invalid",
                name="Guest", is_guest=True)
    db.add(user)
    db.commit()
    yield user
    db.rollback()
    db.execute(delete(StudySpace).where(StudySpace.created_by == user.id))
    db.execute(delete(User).where(User.id == user.id))
    db.commit()


@pytest.fixture
def configured(monkeypatch, world):
    monkeypatch.setenv("DEMO_TEMPLATE_SPACE_ID", str(world.space.id))
    monkeypatch.setenv("DEMO_DAILY_LIMIT", "1000")
    return world


def _owned(db, guest):
    return db.scalar(select(func.count()).select_from(StudySpace)
                     .where(StudySpace.created_by == guest.id))


def test_guest_gets_a_sandbox(client, as_user, guest, configured):
    as_user(guest)
    res = client.post("/demo")
    assert res.status_code == 200
    body = res.json()
    assert body["is_demo"] is True
    assert body["course_name"] == "Test course (demo)"


def test_second_call_returns_the_same_sandbox(client, as_user, guest, configured, db):
    as_user(guest)
    first = client.post("/demo").json()["id"]
    second = client.post("/demo").json()["id"]
    assert first == second
    assert _owned(db, guest) == 1


def test_concurrent_calls_make_one_sandbox(client, as_user, guest, configured, db):
    as_user(guest)
    with ThreadPoolExecutor(max_workers=2) as pool:
        ids = list(pool.map(lambda _i: client.post("/demo").json()["id"], range(2)))
    assert ids[0] == ids[1]
    assert _owned(db, guest) == 1


def test_normal_user_is_refused(client, as_user, configured):
    as_user(configured.alice)
    assert client.post("/demo").status_code == 403


def test_no_template_means_busy(client, as_user, guest, monkeypatch):
    monkeypatch.delenv("DEMO_TEMPLATE_SPACE_ID", raising=False)
    as_user(guest)
    res = client.post("/demo")
    assert res.status_code == 503
    assert res.json()["detail"] == BUSY


def test_missing_template_means_busy(client, as_user, guest, monkeypatch):
    monkeypatch.setenv("DEMO_TEMPLATE_SPACE_ID", str(uuid.uuid4()))
    as_user(guest)
    assert client.post("/demo").status_code == 503


def test_daily_cap_means_busy(client, as_user, guest, configured, monkeypatch):
    monkeypatch.setenv("DEMO_DAILY_LIMIT", "0")
    as_user(guest)
    res = client.post("/demo")
    assert res.status_code == 503
    assert res.json()["detail"] == BUSY
