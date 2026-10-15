"""Who may touch what: every space and document route against an outsider.

world: alice owns the space, bob is a member, eve is signed in but belongs to
no space at all. Each route is checked both ways — eve is refused, and a
member is not — so a route that 403s everyone cannot pass as "secure".
"""
import uuid

import pytest

from models import AgentRequest, Document, StudySpace, StudySpaceMember

SPACE_READS = [
    "/study-spaces/{space}",
    "/study-spaces/{space}/document",
    "/study-spaces/{space}/documents",
    "/study-spaces/{space}/members",
    "/study-spaces/{space}/sources",
    "/study-spaces/{space}/chat",
]

DOCUMENT_READS = [
    "/documents/{doc}",
    "/documents/{doc}/comments",
    "/documents/{doc}/agent-requests",
    "/documents/{doc}/quiz",
    "/documents/{doc}/study-guide",
    "/documents/{doc}/weak-spots",
    "/suggestions/document/{doc}",
]


def _url(template, world):
    return template.format(space=world.space.id, doc=world.doc.id)


@pytest.mark.parametrize("template", SPACE_READS + DOCUMENT_READS)
def test_outsider_cannot_read(world, client, as_user, template):
    as_user(world.eve)
    assert client.get(_url(template, world)).status_code == 403


@pytest.mark.parametrize(
    "template",
    [
        "/study-spaces/{space}",
        "/study-spaces/{space}/documents",
        "/study-spaces/{space}/members",
        "/documents/{doc}",
        "/documents/{doc}/comments",
        "/suggestions/document/{doc}",
    ],
)
def test_member_can_read(world, client, as_user, template):
    as_user(world.bob)
    assert client.get(_url(template, world)).status_code == 200


def test_outsider_cannot_rename_a_document(db, world, client, as_user):
    as_user(world.eve)
    res = client.patch(f"/documents/{world.doc.id}", json={"title": "Taken over"})
    assert res.status_code == 403
    db.refresh(world.doc)
    assert world.doc.title == "Test doc"


def test_outsider_cannot_delete_a_document(db, world, client, as_user):
    as_user(world.eve)
    assert client.delete(f"/documents/{world.doc.id}").status_code == 403
    assert db.get(Document, world.doc.id) is not None


def test_outsider_cannot_add_a_document(db, world, client, as_user):
    as_user(world.eve)
    res = client.post(f"/study-spaces/{world.space.id}/documents", json={"title": "Mine"})
    assert res.status_code == 403
    assert db.query(Document).filter_by(study_space_id=world.space.id).count() == 1


def test_outsider_cannot_queue_an_agent_check(db, world, client, as_user):
    # A check spends a model call, so a refused one must leave no row behind
    # for the worker to claim.
    as_user(world.eve)
    res = client.post(
        f"/documents/{world.doc.id}/agent-requests",
        json={"passage": "Glycolysis makes 2 ATP.", "anchor": {}},
    )
    assert res.status_code == 403
    assert db.query(AgentRequest).filter_by(document_id=world.doc.id).count() == 0


def test_outsider_cannot_invite_themselves(db, world, client, as_user):
    as_user(world.eve)
    res = client.post(f"/study-spaces/{world.space.id}/members", json={"email": world.eve.email})
    assert res.status_code == 403
    assert db.get(StudySpaceMember, (world.space.id, world.eve.id)) is None


def test_member_cannot_rename_the_space(db, world, client, as_user):
    as_user(world.bob)
    res = client.patch(f"/study-spaces/{world.space.id}", json={"course_name": "Renamed"})
    assert res.status_code == 403
    db.refresh(world.space)
    assert world.space.course_name == "Test course"


def test_member_cannot_delete_the_space(db, world, client, as_user):
    as_user(world.bob)
    assert client.delete(f"/study-spaces/{world.space.id}").status_code == 403
    db.expire_all()
    assert db.get(StudySpace, world.space.id) is not None


def test_member_cannot_invite(db, world, client, as_user):
    as_user(world.bob)
    res = client.post(f"/study-spaces/{world.space.id}/members", json={"email": world.eve.email})
    assert res.status_code == 403
    assert db.get(StudySpaceMember, (world.space.id, world.eve.id)) is None


def test_unknown_ids_are_404_not_403(world, client, as_user):
    # Membership can only be checked against something that exists; an id
    # that matches nothing says so rather than claiming a permission problem.
    as_user(world.eve)
    missing = uuid.uuid4()
    assert client.get(f"/study-spaces/{missing}").status_code == 404
    assert client.get(f"/documents/{missing}").status_code == 404


def test_no_token_is_401(world, client):
    assert client.get(f"/documents/{world.doc.id}").status_code == 401
    assert client.get("/study-spaces").status_code == 401
