"""
Request authentication.

Identity comes from a Supabase Auth JWT presented as `Authorization: Bearer`.
Supabase stores its users in `auth.users`; this app keeps its own `users`
table that every foreign key already points at. The two are reconciled by
using the SAME uuid on both sides, so a token's `sub` claim IS `users.id` —
there is no lookup table and no extra query to translate between them.

Rows are normally created by the `on_auth_user_created` trigger (see
infra/supabase/010_auth_sync.sql). The just-in-time upsert here is the
fallback for two cases the trigger cannot cover: a project where the trigger
has not been applied yet, and local development against the docker-compose
database, which has no `auth` schema at all.
"""
import os
import secrets
import uuid
from functools import lru_cache
from typing import Annotated

import jwt
from fastapi import Depends, Header, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import PyJWKClient
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from database import get_db
from models import User

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")

# Optional. Projects created before May 2025 sign with a shared HS256 secret;
# newer ones default to asymmetric ES256 keys published at a JWKS endpoint.
# Setting this forces the symmetric path; leaving it unset uses JWKS.
SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET", "")

AGENT_SERVICE_TOKEN = os.getenv("AGENT_SERVICE_TOKEN", "")

_bearer = HTTPBearer(auto_error=True)


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


@lru_cache(maxsize=1)
def _jwk_client() -> PyJWKClient:
    """Caches fetched signing keys, so verification costs no network call
    per request once the key set is warm."""
    if not SUPABASE_URL:
        raise RuntimeError(
            "SUPABASE_URL must be set to verify tokens (or set "
            "SUPABASE_JWT_SECRET to use the legacy symmetric secret)."
        )
    return PyJWKClient(f"{SUPABASE_URL}/auth/v1/.well-known/jwks.json")


def decode_token(token: str) -> dict:
    """Verify signature, expiry, audience and issuer. Raises 401 on any
    failure — never leaks which specific check failed."""
    options = {"require": ["exp", "sub"]}
    issuer = f"{SUPABASE_URL}/auth/v1" if SUPABASE_URL else None
    common = {
        "audience": "authenticated",
        "options": options,
    }
    if issuer:
        common["issuer"] = issuer

    try:
        if SUPABASE_JWT_SECRET:
            return jwt.decode(
                token, SUPABASE_JWT_SECRET, algorithms=["HS256"], **common
            )
        signing_key = _jwk_client().get_signing_key_from_jwt(token).key
        return jwt.decode(
            token, signing_key, algorithms=["ES256", "RS256"], **common
        )
    except jwt.PyJWTError as exc:
        raise _unauthorized("Invalid or expired token") from exc


def get_current_user(
    creds: Annotated[HTTPAuthorizationCredentials, Depends(_bearer)],
    db: Annotated[Session, Depends(get_db)],
) -> User:
    claims = decode_token(creds.credentials)

    try:
        user_id = uuid.UUID(claims["sub"])
    except (KeyError, ValueError) as exc:
        raise _unauthorized("Token has no usable subject") from exc

    user = db.get(User, user_id)
    if user is not None:
        return user

    # Not mirrored yet. Create the row with the token's own id so every
    # existing foreign key lines up.
    email = claims.get("email") or f"{user_id}@unknown.invalid"
    name = (claims.get("user_metadata") or {}).get("name") or email.split("@")[0]

    user = User(id=user_id, email=email, name=name)
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        # Raced with the trigger, or this email already belongs to a row
        # created before auth existed (the seed user, for instance).
        db.rollback()
        user = db.get(User, user_id) or db.query(User).filter_by(email=email).one_or_none()
        if user is None:
            raise
    else:
        db.refresh(user)
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


def require_agent(x_agent_token: Annotated[str | None, Header()] = None) -> None:
    """
    Guards the one endpoint written by a machine rather than a browser.

    apps/agent-worker/agent.py POSTs suggestions with no human behind it, so
    it has no Supabase session. Giving the worker a real user account is a
    service-account rabbit hole; a shared secret is the right weight for now.
    """
    if not AGENT_SERVICE_TOKEN:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="AGENT_SERVICE_TOKEN is not configured on the server",
        )
    if not x_agent_token or not secrets.compare_digest(
        x_agent_token, AGENT_SERVICE_TOKEN
    ):
        raise _unauthorized("Invalid agent token")
