import uuid

from models import QuizAttempt

from .conftest import make_quiz


def test_attempt_round_trips(db, world):
    quiz = make_quiz(db, world.doc, world.alice)
    db.add(QuizAttempt(quiz_id=quiz.id, user_id=world.alice.id, answers=[0, 1, 2], score=3))
    db.commit()
    saved = db.query(QuizAttempt).filter_by(quiz_id=quiz.id).one()
    assert saved.answers == [0, 1, 2]
    assert saved.submitted_at is not None
    assert quiz.sections == ["Glycolysis", "Krebs cycle"]
    assert quiz.personal_for is None


def test_guide_and_quiz_store_source_ids(db, world):
    from models import Quiz, StudyGuide

    ids = [uuid.uuid4(), uuid.uuid4()]
    guide = StudyGuide(document_id=world.doc.id, requested_by=world.alice.id,
                       notes="n", source_ids=ids)
    quiz = Quiz(document_id=world.doc.id, requested_by=world.alice.id, notes="n")
    db.add_all([guide, quiz])
    db.commit()
    db.refresh(guide)
    db.refresh(quiz)
    assert guide.source_ids == ids
    assert quiz.source_ids is None
