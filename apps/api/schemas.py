"""
Response models.

Handlers previously returned ORM objects directly, which serialises whatever
columns happen to exist and silently changes shape whenever models.py does.
Declaring the wire format explicitly also gives packages/shared/types.ts
something concrete to mirror.
"""
import uuid
from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, StringConstraints


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# Shape only: something@something, no whitespace.
#
# Deliberately not EmailStr. EmailStr applies RFC deliverability rules, which
# reject reserved TLDs — .local, .test, .invalid — and those are exactly the
# addresses local development runs on: LoginScreen.tsx offers ada@test.local
# as its own placeholder, and dev_auth.py mints tokens for whatever is typed.
# With EmailStr, signing in as ada@test.local worked while inviting
# bob@test.local came back 422, so the two-user flow the README describes
# could not be completed at all.
#
# Nothing is lost by relaxing it, because neither endpoint using it ever sends
# mail. Both look the address up in the users table, and that lookup — not a
# validator — is what decides whether an address means anything: an invite to
# an address nobody signed up with already 404s, spelled correctly or not.
LooseEmail = Annotated[str, StringConstraints(min_length=3, pattern=r"^[^@\s]+@[^@\s]+$")]


class UserOut(ORMModel):
    id: uuid.UUID
    email: str
    name: str


class StudySpaceOut(ORMModel):
    id: uuid.UUID
    course_name: str
    created_by: uuid.UUID
    created_at: datetime


class MemberOut(BaseModel):
    user_id: uuid.UUID
    email: str
    name: str
    role: str
    joined_at: datetime


class DocumentOut(ORMModel):
    id: uuid.UUID
    study_space_id: uuid.UUID
    updated_at: datetime


class DocumentWithSnapshotOut(DocumentOut):
    # base64-encoded Yjs update, or null for a document nobody has opened yet.
    crdt_snapshot: str | None


class SourceOut(ORMModel):
    """One uploaded piece of course material.

    file_data is deliberately absent: it is the only column here that is
    unbounded in size, and no client has any use for the original bytes —
    the searchable form is source_chunks, and re-chunking happens in the
    worker. Leaving it out of the response model means a careless
    `return source` can never stream a 20MB PDF back through the list
    endpoint.
    """

    id: uuid.UUID
    study_space_id: uuid.UUID
    filename: str
    uploaded_by: uuid.UUID
    uploaded_at: datetime
    status: str  # pending | processing | ready | failed
    content_type: str | None
    byte_size: int | None
    # Populated for 'failed' only. Surfaced to the UI verbatim, because the
    # most common failure — a scanned PDF with no text layer — is only
    # actionable if the person who uploaded it is told that is what happened.
    error: str | None
    attempts: int
    ingested_at: datetime | None
    # Counted per request rather than denormalized onto the row: the worker
    # would otherwise have to keep a second copy of this in sync, and it is
    # the number that tells you whether ingestion actually did anything.
    chunk_count: int


class SuggestionOut(ORMModel):
    id: uuid.UUID
    document_id: uuid.UUID
    type: str
    anchor: dict
    proposed_text: str
    source_chunk_id: uuid.UUID | None
    status: str
    created_at: datetime
    resolved_by: uuid.UUID | None
    resolved_at: datetime | None


class CreateStudySpace(BaseModel):
    course_name: str


class UpdateStudySpace(BaseModel):
    course_name: str


class InviteMember(BaseModel):
    # Email, not user_id: a client has no way to know another user's uuid.
    email: LooseEmail


class DevLogin(BaseModel):
    """Local development only — see routers/dev_auth.py."""

    # See LooseEmail: this address is never mailed and never verified — any
    # address at all is the point of dev login.
    email: LooseEmail
    name: str | None = None


class DevLoginOut(BaseModel):
    access_token: str
    user: UserOut
