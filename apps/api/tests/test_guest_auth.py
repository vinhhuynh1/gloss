"""Anonymous Supabase tokens become guest users; normal tokens do not."""
import uuid
from types import SimpleNamespace

from sqlalchemy import delete

import auth
from models import User


def _resolve(db, monkeypatch, claims):
    monkeypatch.setattr(auth, "decode_token", lambda _token: claims)
    return auth.get_current_user(SimpleNamespace(credentials="token"), db)


def test_anonymous_token_creates_a_guest(db, monkeypatch):
    uid = uuid.uuid4()
    try:
        user = _resolve(db, monkeypatch, {"sub": str(uid), "is_anonymous": True, "email": ""})
        assert user.is_guest is True
        assert user.name == "Guest"
        assert user.email == f"guest-{uid}@demo.invalid"
    finally:
        db.execute(delete(User).where(User.id == uid))
        db.commit()


def test_normal_token_is_not_a_guest(db, monkeypatch):
    uid = uuid.uuid4()
    email = f"real-{uid.hex[:8]}@example.test"
    try:
        user = _resolve(
            db,
            monkeypatch,
            {"sub": str(uid), "email": email, "user_metadata": {"name": "Real Person"}},
        )
        assert user.is_guest is False
        assert user.name == "Real Person"
        assert user.email == email
    finally:
        db.execute(delete(User).where(User.id == uid))
        db.commit()
