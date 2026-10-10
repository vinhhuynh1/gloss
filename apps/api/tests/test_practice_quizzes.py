from models import Quiz

from .conftest import make_quiz

PRACTICE = {"notes": "Glycolysis\n\nTwo ATP.", "sections": ["Glycolysis"]}


def _practice(client, doc):
    return client.post(f"/documents/{doc.id}/quiz/practice", json=PRACTICE)


def test_practice_quiz_is_private(world, client, as_user):
    as_user(world.alice)
    res = _practice(client, world.doc)
    assert res.status_code == 202
    quiz_id = res.json()["id"]
    assert client.get(f"/quizzes/{quiz_id}").status_code == 200

    as_user(world.bob)
    assert client.get(f"/quizzes/{quiz_id}").status_code == 404
    assert client.get(f"/quizzes/{quiz_id}/content").status_code == 404


def test_non_member_gets_404_not_403(db, world, client, as_user):
    group = make_quiz(db, world.doc, world.alice)
    as_user(world.eve)
    assert client.get(f"/quizzes/{group.id}").status_code == 404


def test_member_can_read_group_quiz_by_id(db, world, client, as_user):
    group = make_quiz(db, world.doc, world.alice)
    as_user(world.bob)
    res = client.get(f"/quizzes/{group.id}/content")
    assert res.status_code == 200
    assert len(res.json()["questions"]["questions"]) == 3


def test_practice_hidden_from_group_latest(db, world, client, as_user):
    group = make_quiz(db, world.doc, world.alice)
    make_quiz(db, world.doc, world.alice, personal_for=world.alice.id)  # newer
    as_user(world.bob)
    assert client.get(f"/documents/{world.doc.id}/quiz").json()["id"] == str(group.id)
    assert client.get(f"/documents/{world.doc.id}/quiz/content").json()["id"] == str(group.id)


def test_practice_does_not_block_group_quiz(world, client, as_user):
    as_user(world.alice)
    assert _practice(client, world.doc).status_code == 202
    as_user(world.bob)
    res = client.post(f"/documents/{world.doc.id}/quiz", json={"notes": "n"})
    assert res.status_code == 202


def test_one_open_practice_quiz_per_person(world, client, as_user):
    as_user(world.alice)
    assert _practice(client, world.doc).status_code == 202
    assert _practice(client, world.doc).status_code == 409
    as_user(world.bob)
    assert _practice(client, world.doc).status_code == 202


def test_practice_needs_a_section(world, client, as_user):
    as_user(world.alice)
    res = client.post(
        f"/documents/{world.doc.id}/quiz/practice",
        json={"notes": "n", "sections": ["   "]},
    )
    assert res.status_code == 422


def test_group_quiz_without_headings_stores_null(db, world, client, as_user):
    # Review Focus 2: notes with no usable headings behave exactly as today.
    as_user(world.alice)
    res = client.post(
        f"/documents/{world.doc.id}/quiz", json={"notes": "n", "sections": ["", "  "]}
    )
    assert res.status_code == 202
    assert db.get(Quiz, res.json()["id"]).sections is None


def test_group_quiz_dedupes_sections(db, world, client, as_user):
    as_user(world.alice)
    res = client.post(
        f"/documents/{world.doc.id}/quiz",
        json={"notes": "n", "sections": ["Glycolysis", "glycolysis", " Krebs cycle "]},
    )
    assert db.get(Quiz, res.json()["id"]).sections == ["Glycolysis", "Krebs cycle"]


def test_too_many_sections_is_refused(world, client, as_user):
    as_user(world.alice)
    res = client.post(
        f"/documents/{world.doc.id}/quiz",
        json={"notes": "n", "sections": [f"H{i}" for i in range(101)]},
    )
    assert res.status_code == 422


def test_overlong_heading_does_not_break_group_quiz(db, world, client, as_user):
    # Final review, Important 1: one pasted-sentence heading must not 422 the
    # whole group quiz over an optional field.
    as_user(world.alice)
    res = client.post(
        f"/documents/{world.doc.id}/quiz",
        json={"notes": "n", "sections": ["Glycolysis", "x" * 201]},
    )
    assert res.status_code == 202
    assert db.get(Quiz, res.json()["id"]).sections == ["Glycolysis"]


def test_quiz_routes_refuse_cleanly_without_015(monkeypatch):
    # Final review, Important 2: table present (014) but 015's columns
    # missing must be a 503 naming the migration, not a 500.
    import pytest
    from fastapi import HTTPException

    from routers import quizzes as quizzes_router

    class OnlyTable:
        def scalar(self, stmt):
            return "to_regclass" in str(stmt)

    monkeypatch.setattr(quizzes_router, "_table_present", False)
    with pytest.raises(HTTPException) as err:
        quizzes_router.require_quizzes_table(OnlyTable())
    assert err.value.status_code == 503
    assert "015" in err.value.detail
