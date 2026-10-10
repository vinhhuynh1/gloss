"""
API tests run against the local docker-compose Postgres (apps/api/.env), not a
mock: the queries under test are Postgres-specific (DISTINCT ON, jsonpath).

Every test builds its own users, space and document and deletes them at the
end, space first so the cascade removes everything a test wrote.

Stop the agent worker first: tests create 'pending' quizzes, and a running
worker would claim them and spend model calls.
"""
import sys
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import delete  # noqa: E402

from auth import get_current_user  # noqa: E402
from database import SessionLocal  # noqa: E402
from main import app  # noqa: E402
from models import Document, Quiz, StudySpace, StudySpaceMember, User  # noqa: E402


@pytest.fixture
def db():
    # expire_on_commit=False: the user objects are handed to the app through
    # a dependency override and read on the TestClient's thread, where an
    # expired attribute would try to refresh through this session.
    session = SessionLocal(expire_on_commit=False)
    yield session
    session.close()


def _user(db, label: str) -> User:
    user = User(
        id=uuid.uuid4(),
        email=f"test-{label}-{uuid.uuid4().hex[:8]}@example.test",
        name=f"Test {label}",
    )
    db.add(user)
    db.commit()
    return user


@pytest.fixture
def world(db):
    alice, bob, eve = _user(db, "alice"), _user(db, "bob"), _user(db, "eve")
    space = StudySpace(course_name="Test course", created_by=alice.id)
    db.add(space)
    db.commit()
    db.add_all(
        [
            StudySpaceMember(study_space_id=space.id, user_id=alice.id, role="owner"),
            StudySpaceMember(study_space_id=space.id, user_id=bob.id, role="member"),
        ]
    )
    doc = Document(study_space_id=space.id, title="Test doc")
    db.add(doc)
    db.commit()
    yield SimpleNamespace(alice=alice, bob=bob, eve=eve, space=space, doc=doc)
    db.rollback()
    # Space first: its delete cascades to members, documents and everything
    # hanging off a document. Then the users. Not relying on 013's cascade
    # from users to the spaces they created, which a local database may not
    # have applied.
    db.execute(delete(StudySpace).where(StudySpace.id == space.id))
    db.execute(delete(User).where(User.id.in_([alice.id, bob.id, eve.id])))
    db.commit()


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def as_user():
    def _set(user: User) -> None:
        app.dependency_overrides[get_current_user] = lambda: user

    yield _set
    app.dependency_overrides.clear()


DEFAULT_QUESTIONS = [
    {"question": "Q1", "options": ["a", "b", "c", "d"], "correct_index": 0,
     "explanation": "e", "source_chunk_id": "x", "section": "Glycolysis"},
    {"question": "Q2", "options": ["a", "b", "c", "d"], "correct_index": 1,
     "explanation": "e", "source_chunk_id": "x", "section": "Glycolysis"},
    {"question": "Q3", "options": ["a", "b", "c", "d"], "correct_index": 2,
     "explanation": "e", "source_chunk_id": "x", "section": "Krebs cycle"},
]


def make_quiz(
    db,
    doc,
    requester,
    *,
    personal_for=None,
    sections=("Glycolysis", "Krebs cycle"),
    status="done",
    questions=None,
):
    """A quiz row written straight to the table, as the worker would leave it."""
    quiz = Quiz(
        document_id=doc.id,
        requested_by=requester.id,
        personal_for=personal_for,
        notes="notes",
        status=status,
        sections=list(sections) if sections else None,
        questions=(
            {"title": "T", "questions": questions or DEFAULT_QUESTIONS}
            if status == "done"
            else None
        ),
    )
    db.add(quiz)
    db.commit()
    return quiz
