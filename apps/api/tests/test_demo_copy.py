"""copy_template: a complete, independent sandbox owned by the guest."""
import uuid

import pytest
from sqlalchemy import delete, func, select, text

import demo
from models import (
    Document,
    Quiz,
    Source,
    SourceChunk,
    StudyGuide,
    StudySpace,
    StudySpaceMember,
    Suggestion,
    User,
)


@pytest.fixture
def template(db, world):
    """The `world` space dressed up as a demo template: a snapshot, one ready
    and one failed source, chunks, one open and one resolved suggestion, two
    done guides and quizzes (only the newest of each should be copied)."""
    db.execute(
        text("UPDATE documents SET crdt_snapshot = :b WHERE id = :d"),
        {"b": b"\x01\x02yjs", "d": world.doc.id},
    )
    ready = Source(study_space_id=world.space.id, filename="lecture.md",
                   uploaded_by=world.alice.id, status="ready")
    failed = Source(study_space_id=world.space.id, filename="broken.pdf",
                    uploaded_by=world.alice.id, status="failed")
    db.add_all([ready, failed])
    db.flush()
    db.add_all([
        SourceChunk(source_id=ready.id, text="slow start doubles cwnd",
                    embedding=[0.0] * 384, page_ref="4.5"),
        SourceChunk(source_id=ready.id, text="three-way handshake",
                    embedding=[0.1] * 384, page_ref="4.2"),
        SourceChunk(source_id=failed.id, text="never copied", embedding=[0.2] * 384),
    ])
    db.add_all([
        Suggestion(document_id=world.doc.id, type="contradiction", anchor={"k": 1},
                   proposed_text="open one", status="pending"),
        Suggestion(document_id=world.doc.id, type="citation", anchor={"k": 2},
                   proposed_text="resolved one", status="accepted"),
    ])
    db.commit()
    db.add_all([
        StudyGuide(document_id=world.doc.id, requested_by=world.alice.id, notes="n",
                   status="done", guide={"v": "old"}),
        Quiz(document_id=world.doc.id, requested_by=world.alice.id, notes="n",
             status="done", questions={"v": "old"}),
    ])
    db.commit()
    db.add_all([
        StudyGuide(document_id=world.doc.id, requested_by=world.alice.id, notes="n",
                   status="done", guide={"v": "new"}),
        Quiz(document_id=world.doc.id, requested_by=world.alice.id, notes="n",
             status="done", questions={"v": "new"}),
    ])
    db.commit()
    return world


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


def _count(db, stmt):
    return db.scalar(select(func.count()).select_from(stmt.subquery()))


def test_copy_makes_a_complete_sandbox(db, template, guest):
    space = demo.copy_template(db, template.space.id, guest)
    db.commit()

    assert space.is_demo is True
    assert space.course_name == "Test course (demo)"
    assert space.created_by == guest.id
    member = db.get(StudySpaceMember, (space.id, guest.id))
    assert member is not None and member.role == "owner"

    docs = db.scalars(select(Document).where(Document.study_space_id == space.id)).all()
    assert len(docs) == 1
    new_doc = docs[0]
    assert new_doc.id != template.doc.id
    assert new_doc.title == "Test doc"
    snapshot = db.scalar(text("SELECT crdt_snapshot FROM documents WHERE id = :d"),
                         {"d": new_doc.id})
    assert bytes(snapshot) == b"\x01\x02yjs"

    sources = db.scalars(select(Source).where(Source.study_space_id == space.id)).all()
    assert [s.filename for s in sources] == ["lecture.md"]  # failed one skipped
    assert sources[0].status == "ready"
    assert sources[0].uploaded_by == guest.id
    assert _count(db, select(SourceChunk).where(SourceChunk.source_id == sources[0].id)) == 2

    suggestions = db.scalars(select(Suggestion).where(Suggestion.document_id == new_doc.id)).all()
    assert [s.proposed_text for s in suggestions] == ["open one"]
    assert suggestions[0].anchor == {"k": 1}

    guides = db.execute(text(
        "SELECT guide, requested_by FROM study_guides WHERE document_id = :d"),
        {"d": new_doc.id}).all()
    assert len(guides) == 1 and guides[0].guide == {"v": "new"}
    assert guides[0].requested_by == guest.id
    quizzes = db.execute(text(
        "SELECT questions, requested_by FROM quizzes WHERE document_id = :d"),
        {"d": new_doc.id}).all()
    assert len(quizzes) == 1 and quizzes[0].questions == {"v": "new"}


def test_copy_leaves_the_template_untouched(db, template, guest):
    before = _count(db, select(Suggestion).where(Suggestion.document_id == template.doc.id))
    demo.copy_template(db, template.space.id, guest)
    db.commit()
    after = _count(db, select(Suggestion).where(Suggestion.document_id == template.doc.id))
    assert before == after == 2


def test_missing_template_raises(db, guest):
    with pytest.raises(demo.DemoUnavailable):
        demo.copy_template(db, uuid.uuid4(), guest)
    db.rollback()


def test_existing_demo_space_and_daily_count(db, template, guest):
    assert demo.existing_demo_space(db, guest) is None
    before = demo.demos_created_today(db)
    space = demo.copy_template(db, template.space.id, guest)
    db.commit()
    assert demo.existing_demo_space(db, guest).id == space.id
    assert demo.demos_created_today(db) == before + 1


def test_template_space_id_parsing(monkeypatch):
    monkeypatch.delenv("DEMO_TEMPLATE_SPACE_ID", raising=False)
    assert demo.template_space_id() is None
    monkeypatch.setenv("DEMO_TEMPLATE_SPACE_ID", "not-a-uuid")
    assert demo.template_space_id() is None
    good = uuid.uuid4()
    monkeypatch.setenv("DEMO_TEMPLATE_SPACE_ID", str(good))
    assert demo.template_space_id() == good


def test_daily_limit_default_and_override(monkeypatch):
    monkeypatch.delenv("DEMO_DAILY_LIMIT", raising=False)
    assert demo.daily_limit() == 50
    monkeypatch.setenv("DEMO_DAILY_LIMIT", "3")
    assert demo.daily_limit() == 3
    monkeypatch.setenv("DEMO_DAILY_LIMIT", "lots")
    assert demo.daily_limit() == 50
