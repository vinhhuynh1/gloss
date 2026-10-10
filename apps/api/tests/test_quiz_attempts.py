from models import QuizAttempt

from .conftest import make_quiz


def _attempt(client, quiz, answers, **extra):
    return client.post(f"/quizzes/{quiz.id}/attempts", json={"answers": answers, **extra})


def _spots(client, doc):
    return {s["section"]: s for s in client.get(f"/documents/{doc.id}/weak-spots").json()}


def test_score_is_computed_server_side(db, world, client, as_user):
    quiz = make_quiz(db, world.doc, world.alice)
    as_user(world.alice)
    res = _attempt(client, quiz, [0, 1, 0], score=3)  # a client "score" is ignored
    assert res.status_code == 201
    assert res.json() == {"score": 2, "total": 3}
    assert db.query(QuizAttempt).filter_by(quiz_id=quiz.id).one().score == 2


def test_wrong_answer_count_is_422(db, world, client, as_user):
    quiz = make_quiz(db, world.doc, world.alice)
    as_user(world.alice)
    assert _attempt(client, quiz, [0, 1]).status_code == 422


def test_out_of_range_answer_is_422(db, world, client, as_user):
    quiz = make_quiz(db, world.doc, world.alice)
    as_user(world.alice)
    assert _attempt(client, quiz, [0, 1, 4]).status_code == 422


def test_unfinished_quiz_is_422(db, world, client, as_user):
    quiz = make_quiz(db, world.doc, world.alice, status="pending")
    as_user(world.alice)
    assert _attempt(client, quiz, [0, 1, 2]).status_code == 422


def test_someone_elses_practice_quiz_is_404(db, world, client, as_user):
    quiz = make_quiz(db, world.doc, world.alice, personal_for=world.alice.id)
    as_user(world.bob)
    assert _attempt(client, quiz, [0, 1, 2]).status_code == 404


def test_attempt_on_replaced_group_quiz_is_accepted(db, world, client, as_user):
    # Review Focus 3.
    older = make_quiz(db, world.doc, world.alice)
    make_quiz(db, world.doc, world.bob)  # a groupmate's newer quiz
    as_user(world.alice)
    assert _attempt(client, older, [0, 1, 2]).status_code == 201


def test_weak_spots_use_latest_attempt(db, world, client, as_user):
    quiz = make_quiz(db, world.doc, world.alice)
    as_user(world.alice)
    _attempt(client, quiz, [1, 0, 2])  # Glycolysis 0/2, Krebs 1/1
    spots = _spots(client, world.doc)
    assert spots["Glycolysis"] == {"section": "Glycolysis", "asked": 2, "correct": 0, "weak": True}
    assert spots["Krebs cycle"]["weak"] is False  # only 1 asked

    _attempt(client, quiz, [0, 1, 2])  # retake, all right
    assert _spots(client, world.doc)["Glycolysis"]["correct"] == 2


def test_weak_spots_count_across_quizzes(db, world, client, as_user):
    first = make_quiz(db, world.doc, world.alice)
    second = make_quiz(db, world.doc, world.alice, personal_for=world.alice.id)
    as_user(world.alice)
    _attempt(client, first, [1, 0, 2])
    _attempt(client, second, [0, 1, 2])
    assert _spots(client, world.doc)["Glycolysis"]["asked"] == 4


def test_weak_spots_are_private(db, world, client, as_user):
    quiz = make_quiz(db, world.doc, world.alice)
    as_user(world.alice)
    _attempt(client, quiz, [1, 0, 2])
    as_user(world.bob)
    assert client.get(f"/documents/{world.doc.id}/weak-spots").json() == []


def test_old_quiz_without_sections_saves_but_does_not_count(db, world, client, as_user):
    # Review Focus 4.
    old = make_quiz(db, world.doc, world.alice, sections=None)
    as_user(world.alice)
    assert _attempt(client, old, [1, 0, 2]).status_code == 201
    assert client.get(f"/documents/{world.doc.id}/weak-spots").json() == []


def test_non_member_cannot_read_weak_spots(world, client, as_user):
    as_user(world.eve)
    assert client.get(f"/documents/{world.doc.id}/weak-spots").status_code == 403
