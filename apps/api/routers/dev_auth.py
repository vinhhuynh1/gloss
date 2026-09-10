"""
Passwordless local login. Mounted only when DEV_AUTH_SECRET is set.

Supabase is the real identity provider, but standing it up costs a project
with email confirmation configured, a schema applied, and a database password
in every .env — none of which has anything to do with the feature being built.
This lets the whole app run against nothing but the local docker-compose
Postgres: type any address, get a token.

This is a permissive ISSUER, not an auth bypass. The token it mints is an
ordinary HS256 JWT carrying the same claims Supabase's does, verified by the
same code path in auth.py and by apps/realtime/auth.js. Every gate downstream
is untouched: endpoints still require a bearer token, authz.py still checks
study-space membership, and the realtime server still authenticates the
WebSocket upgrade. That matters for testing — the "you were removed from this
space" states are gates, and a bypass would make them unreachable.

Two things keep it out of production: main.py mounts this router only when
DEV_AUTH_SECRET is set, and auth.py only accepts these signatures under the
same condition. A deployment that does not set it cannot reach either half.
"""
import uuid
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from auth import DEV_AUTH_SECRET, upsert_user
from database import get_db
from schemas import DevLogin, DevLoginOut

router = APIRouter(prefix="/dev", tags=["dev"])

# Long enough to not interrupt a session, short enough to still exercise the
# `exp` claim that decode_token requires.
TOKEN_TTL = timedelta(hours=12)


def user_id_for_email(email: str) -> uuid.UUID:
    """
    Derive a stable uuid from the address instead of generating one.

    Same email, same user, across restarts and across a wiped database. That
    keeps colorFromUserId() in SpacePage.tsx giving each collaborator the same
    cursor colour every session, and it means inviting a classmate by an
    address they have not "signed up" with yet still resolves to them.
    """
    return uuid.uuid5(uuid.NAMESPACE_URL, f"mailto:{email.strip().lower()}")


@router.post("/login", response_model=DevLoginOut)
def dev_login(body: DevLogin, db: Session = Depends(get_db)):
    email = str(body.email).strip().lower()
    user_id = user_id_for_email(email)
    name = (body.name or "").strip() or email.split("@")[0]

    user = upsert_user(db, user_id, email, name)

    now = datetime.now(timezone.utc)
    token = jwt.encode(
        {
            "sub": str(user.id),
            # decode_token verifies this, so it has to match Supabase's.
            "aud": "authenticated",
            "iat": now,
            "exp": now + TOKEN_TTL,
            "email": user.email,
            # Where get_current_user looks for the display name, and what
            # becomes the collaborator's cursor label.
            "user_metadata": {"name": user.name},
        },
        DEV_AUTH_SECRET,
        algorithm="HS256",
    )

    # No `iss`: auth.py and apps/realtime/auth.js both skip the issuer check
    # when SUPABASE_URL is unset, which is exactly the dev configuration.
    return DevLoginOut(access_token=token, user=user)
