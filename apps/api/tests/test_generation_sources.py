"""Study guide and quiz requests may name the sources to build from.
Omitted means all of them, stored as NULL."""
import uuid

import pytest

from models import Quiz, Source, StudyGuide, StudySpace


@pytest.fixture
def two_sources(db, world):
    made = [
        Source(study_space_id=world.space.id, filename=f"{n}.md", uploaded_by=world.alice.id,
               status="ready", content_type="text/markdown", byte_size=1)
        for n in ("a", "b")
    ]
    db.add_all(made)
    db.commit()
    return made


def test_guide_stores_chosen_sources(client, as_user, db, world, two_sources):
    as_user(world.alice)
    chosen = str(two_sources[1].id)
    res = client.post(f"/documents/{world.doc.id}/study-guide",
                      json={"notes": "n", "source_ids": [chosen, chosen]})
    assert res.status_code == 202
    guide = db.get(StudyGuide, uuid.UUID(res.json()["id"]))
    db.refresh(guide)
    assert guide.source_ids == [two_sources[1].id]


def test_omitted_means_all(client, as_user, db, world, two_sources):
    as_user(world.alice)
    res = client.post(f"/documents/{world.doc.id}/quiz", json={"notes": "n"})
    quiz = db.get(Quiz, uuid.UUID(res.json()["id"]))
    db.refresh(quiz)
    assert quiz.source_ids is None


def test_empty_list_refused(client, as_user, world, two_sources):
    as_user(world.alice)
    res = client.post(f"/documents/{world.doc.id}/quiz", json={"notes": "n", "source_ids": []})
    assert res.status_code == 422


def test_source_from_another_space_refused(client, as_user, db, world, two_sources):
    other = StudySpace(course_name="Other", created_by=world.eve.id)
    db.add(other)
    db.commit()
    foreign = Source(study_space_id=other.id, filename="x.md", uploaded_by=world.eve.id,
                     status="ready")
    db.add(foreign)
    db.commit()
    try:
        as_user(world.alice)
        res = client.post(f"/documents/{world.doc.id}/study-guide",
                          json={"notes": "n", "source_ids": [str(foreign.id)]})
        assert res.status_code == 404
        assert db.query(StudyGuide).filter_by(document_id=world.doc.id).count() == 0
    finally:
        db.rollback()
        db.delete(foreign)
        db.commit()
        db.delete(other)
        db.commit()


def test_practice_quiz_stores_chosen_sources(client, as_user, db, world, two_sources):
    as_user(world.alice)
    res = client.post(f"/documents/{world.doc.id}/quiz/practice",
                      json={"notes": "n", "sections": ["Glycolysis"],
                            "source_ids": [str(two_sources[0].id)]})
    assert res.status_code == 202
    quiz = db.get(Quiz, uuid.UUID(res.json()["id"]))
    db.refresh(quiz)
    assert quiz.source_ids == [two_sources[0].id]
