def test_member_can_read_document(world, client, as_user):
    as_user(world.alice)
    res = client.get(f"/documents/{world.doc.id}/quiz")
    # No quiz yet: 404 from the route itself, which proves auth, membership
    # and the database all worked.
    assert res.status_code == 404
    assert "No quiz" in res.json()["detail"]


def test_non_member_is_refused(world, client, as_user):
    as_user(world.eve)
    assert client.get(f"/documents/{world.doc.id}/quiz").status_code == 403
