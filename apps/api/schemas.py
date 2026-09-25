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
    # Where the grounding passage came from, snapshotted at creation. The
    # sidebar shows these so a reader can check the claim, and an accepted
    # citation is built from them rather than from model-written text.
    source_filename: str | None
    source_page_ref: str | None
    source_excerpt: str | None
    status: str
    created_at: datetime
    resolved_by: uuid.UUID | None
    resolved_at: datetime | None


# Long enough for several paragraphs, short enough that one request cannot
# ship a whole document into a prompt. Retrieval embeds the passage as one
# query, and a query that long matches everything a little and nothing well.
MAX_PASSAGE_CHARS = 4000


class CreateAgentRequest(BaseModel):
    passage: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_PASSAGE_CHARS)
    ]
    # Serialized Yjs relative positions, opaque to the API — see
    # apps/web/src/lib/anchors.ts. Shape-checked in the router, not here, so
    # the error names the missing key.
    anchor: dict


class AgentRequestOut(ORMModel):
    id: uuid.UUID
    document_id: uuid.UUID
    passage: str
    status: str  # pending | processing | done | failed
    attempts: int
    error: str | None
    result_type: str | None  # none | citation | contradiction | gap_fill
    suggestion_id: uuid.UUID | None
    created_at: datetime
    finished_at: datetime | None


# The whole notes document, where MAX_PASSAGE_CHARS is one selection, so this
# is larger by the same order. Still a cap: the document is embedded section by
# section and then sent whole in one prompt, so an unbounded value turns one
# click into an unbounded number of embeddings and a prompt no context window
# holds. A document this long is also past the point where one guide is the
# right shape for it.
MAX_NOTES_CHARS = 40000


class CreateStudyGuide(BaseModel):
    # Sent by the client, not read from documents.crdt_snapshot, because that
    # column is a Yjs update and nothing in Python can decode one. Same
    # arrangement as CreateAgentRequest.passage.
    notes: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_NOTES_CHARS)
    ]


class StudyGuideStatusOut(ORMModel):
    """Is it ready yet — the shape the editor polls.

    Deliberately carries no `guide` and no `notes`: both are deferred on the
    model, and a poll that answers "still working" must not drag the finished
    guide across the wire to say so.
    """

    id: uuid.UUID
    document_id: uuid.UUID
    status: str  # pending | processing | done | failed
    attempts: int
    error: str | None
    created_at: datetime
    finished_at: datetime | None


class StudyGuideOut(StudyGuideStatusOut):
    """The finished guide, fetched once after the poll reports 'done'.

    `guide` is left as a plain dict rather than modelled field by field. Its
    shape is the model's structured output (see GUIDE_SCHEMA in
    apps/agent-worker/study_guide.py), and declaring it twice would mean two
    places to change and a 500 for any guide written before the change.
    """

    guide: dict | None


# A comment, not a document. Long enough for a real explanation, short enough
# that the comments list stays cheap to poll — this bound is why
# Comment.body is not a deferred column the way study_guides.notes is.
MAX_COMMENT_CHARS = 4000


class CreateComment(BaseModel):
    """A new thread root: body plus the passage it is about."""

    body: Annotated[
        str,
        StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_COMMENT_CHARS),
    ]
    # Serialized Yjs relative positions, opaque to the API — same shape and
    # same reasoning as CreateAgentRequest.anchor. Shape-checked in the router
    # so the error names the missing key.
    anchor: dict
    # The passage as it read when the thread was opened, so a comment whose
    # text is later deleted can still say what it was about.
    quote: Annotated[str, StringConstraints(max_length=MAX_PASSAGE_CHARS)] = ""


class CreateReply(BaseModel):
    """A reply carries no anchor: it belongs to its parent's passage. The
    CHECK constraint in 006_comments.sql enforces the same thing."""

    body: Annotated[
        str,
        StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_COMMENT_CHARS),
    ]


class UpdateComment(BaseModel):
    body: Annotated[
        str,
        StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_COMMENT_CHARS),
    ]


class CommentOut(ORMModel):
    """One comment, root or reply.

    Carries the author's name and email rather than only author_id: the
    sidebar has to render "Khang said" without a second request per comment,
    and the client has no other way to resolve a uuid to a person.
    """

    id: uuid.UUID
    document_id: uuid.UUID
    parent_id: uuid.UUID | None
    author_id: uuid.UUID
    author_name: str
    author_email: str
    body: str
    # Roots only; null on every reply.
    anchor: dict | None
    quote: str | None
    resolved_at: datetime | None
    resolved_by: uuid.UUID | None
    created_at: datetime
    edited_at: datetime | None
    # User ids @mentioned in this body, parsed at write time. The UI uses
    # these to highlight; nothing here sends mail.
    mentioned_user_ids: list[uuid.UUID]


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
