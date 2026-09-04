"""
Response models.

Handlers previously returned ORM objects directly, which serialises whatever
columns happen to exist and silently changes shape whenever models.py does.
Declaring the wire format explicitly also gives packages/shared/types.ts
something concrete to mirror.
"""
import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


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
    email: EmailStr
