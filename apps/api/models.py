import uuid
from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import ForeignKey, Integer, LargeBinary, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from database import Base


def uuid_pk():
    return mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = uuid_pk()
    email: Mapped[str] = mapped_column(String, unique=True)
    name: Mapped[str] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(default=datetime.utcnow)


class StudySpace(Base):
    __tablename__ = "study_spaces"

    id: Mapped[uuid.UUID] = uuid_pk()
    course_name: Mapped[str] = mapped_column(String)
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(default=datetime.utcnow)

    # passive_deletes hands the cascade to Postgres, which the schema already
    # declares as ON DELETE CASCADE. Without it SQLAlchemy loads the children
    # on delete and tries to null out study_space_id — a NOT NULL column — so
    # deleting a space fails with an IntegrityError.
    documents: Mapped[list["Document"]] = relationship(
        back_populates="study_space",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    sources: Mapped[list["Source"]] = relationship(
        back_populates="study_space",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class StudySpaceMember(Base):
    __tablename__ = "study_space_members"

    study_space_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("study_spaces.id"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id"), primary_key=True
    )
    role: Mapped[str] = mapped_column(String, default="member")  # owner | member
    joined_at: Mapped[datetime] = mapped_column(default=datetime.utcnow)


class Document(Base):
    __tablename__ = "documents"

    id: Mapped[uuid.UUID] = uuid_pk()
    study_space_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("study_spaces.id"))
    # Latest Yjs document state. The API treats this as an opaque blob, and
    # so does everything else in Python — decoding a Yjs update needs a CRDT
    # library neither service carries. apps/realtime is the only process in
    # the stack that can read it. The agent worker never touches this column:
    # the text it works from is sent by the browser, as agent_requests.passage
    # and study_guides.notes.
    #
    # WRITER OF RECORD: apps/realtime. It flushes here on a debounce and on
    # shutdown. PUT /documents/{id}/snapshot writes the same column and is a
    # second writer — see the note in routers/documents.py.
    #
    # Deferred, for the same reason file_data is, and with more at stake. A
    # Yjs update encodes the whole edit history, tombstones included, so this
    # grows for as long as the doc is used and never shrinks. authz.py's
    # require_document() is a `db.get(Document, ...)`, and it sits on the two
    # endpoints useSuggestions.ts polls — every 2s while a check runs, every
    # 10s forever otherwise, for the life of every open tab. Four of its six
    # callers drop the Document on the floor. Undeferred, an idle editor tab
    # read the whole document out of Postgres twelve times a minute — two
    # endpoints, six ticks — and sent none of it to anyone.
    #
    # Only routers/documents.py:get_document wants the bytes, and it is the
    # one endpoint the web app never calls.
    crdt_snapshot: Mapped[bytes | None] = mapped_column(
        LargeBinary, nullable=True, deferred=True
    )
    # A name for the tab. NOT NULL with a server default (008), so every row
    # that predates the column is already valid.
    title: Mapped[str] = mapped_column(Text, default="Untitled")
    updated_at: Mapped[datetime] = mapped_column(default=datetime.utcnow)
    # Ordering for the document list. Deliberately not updated_at: sorting a
    # sidebar by last-edited reshuffles it under the reader as somebody types,
    # so the entry they were about to click moves.
    created_at: Mapped[datetime] = mapped_column(default=datetime.utcnow)

    study_space: Mapped["StudySpace"] = relationship(back_populates="documents")
    suggestions: Mapped[list["Suggestion"]] = relationship(
        back_populates="document",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class Source(Base):
    __tablename__ = "sources"

    id: Mapped[uuid.UUID] = uuid_pk()
    study_space_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("study_spaces.id"))
    filename: Mapped[str] = mapped_column(String)
    uploaded_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    uploaded_at: Mapped[datetime] = mapped_column(default=datetime.utcnow)

    # pending | processing | ready | failed. The API only ever writes
    # 'pending' (on upload) and 'failed' -> 'pending' (on retry); every other
    # transition belongs to apps/agent-worker/worker.py, which is the only
    # process that can actually chunk and embed. See 003_source_ingestion.sql.
    status: Mapped[str] = mapped_column(String, default="pending")
    # The uploaded bytes, kept so the corpus can be re-chunked later
    # (worker.py --requeue reads them back).
    #
    # Deferred, and that is load-bearing rather than an optimization. Leaving
    # it out of SourceOut keeps a 20MB PDF off the wire — see schemas.py — but
    # says nothing about the query, and `select(Source)` happily pulls every
    # byte out of Postgres before the response model discards it. On
    # /study-spaces/{id}/sources, which SourcesPanel polls every 2.5s while a
    # source is unsettled, that read ran a Supabase egress quota to 295%
    # against a 32MB database.
    #
    # Deferring here rather than per-query because the leak comes back the
    # moment someone writes another `select(Source)` somewhere else. The
    # column loads on attribute access if anything genuinely needs it; nothing
    # in the API does. The worker is unaffected — it goes through psycopg and
    # names the column explicitly.
    file_data: Mapped[bytes | None] = mapped_column(
        LargeBinary, nullable=True, deferred=True
    )
    content_type: Mapped[str | None] = mapped_column(String, nullable=True)
    byte_size: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    claimed_at: Mapped[datetime | None] = mapped_column(nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    ingested_at: Mapped[datetime | None] = mapped_column(nullable=True)

    study_space: Mapped["StudySpace"] = relationship(back_populates="sources")
    chunks: Mapped[list["SourceChunk"]] = relationship(
        back_populates="source",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class SourceChunk(Base):
    __tablename__ = "source_chunks"

    id: Mapped[uuid.UUID] = uuid_pk()
    source_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("sources.id"))
    text: Mapped[str] = mapped_column(Text)
    embedding = mapped_column(Vector(384))
    page_ref: Mapped[str | None] = mapped_column(String, nullable=True)

    source: Mapped["Source"] = relationship(back_populates="chunks")


class Suggestion(Base):
    __tablename__ = "suggestions"

    id: Mapped[uuid.UUID] = uuid_pk()
    document_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("documents.id"))
    type: Mapped[str] = mapped_column(String)  # citation | contradiction | gap_fill
    anchor: Mapped[dict] = mapped_column(JSONB)  # serialized Yjs relative position
    proposed_text: Mapped[str] = mapped_column(Text)
    # ON DELETE SET NULL (004_agent_requests.sql): re-chunking a source must
    # not be blocked by a suggestion that cites one of its old chunks.
    source_chunk_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("source_chunks.id"), nullable=True
    )
    # Copied from the cited chunk when the suggestion is written, so the
    # citation outlives the chunk id.
    source_filename: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_page_ref: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_excerpt: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String, default="pending")
    created_at: Mapped[datetime] = mapped_column(default=datetime.utcnow)
    resolved_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id"), nullable=True
    )
    resolved_at: Mapped[datetime | None] = mapped_column(nullable=True)

    document: Mapped["Document"] = relationship(back_populates="suggestions")


class AgentRequest(Base):
    """One "check this passage" request from the editor.

    pending | processing | done | failed. The API only ever writes 'pending'
    (on creation); every other transition belongs to apps/agent-worker/
    worker.py, the only process that can run retrieval. See
    004_agent_requests.sql.
    """

    __tablename__ = "agent_requests"

    id: Mapped[uuid.UUID] = uuid_pk()
    document_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("documents.id"))
    requested_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    passage: Mapped[str] = mapped_column(Text)
    anchor: Mapped[dict] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(String, default="pending")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    claimed_at: Mapped[datetime | None] = mapped_column(nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    result_type: Mapped[str | None] = mapped_column(String, nullable=True)
    reasoning: Mapped[str | None] = mapped_column(Text, nullable=True)
    suggestion_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("suggestions.id"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(default=datetime.utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(nullable=True)


class StudyGuide(Base):
    """One generated revision guide for a document.

    pending | processing | done | failed, and the same queue-as-table as
    AgentRequest — see 005_study_guides.sql. The API only ever writes
    'pending'; apps/agent-worker/worker.py owns every other transition,
    because generating a guide needs retrieval and retrieval needs the
    embedding model.
    """

    __tablename__ = "study_guides"

    id: Mapped[uuid.UUID] = uuid_pk()
    document_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("documents.id"))
    requested_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    # The document's text as the browser read it. Deferred: this is the whole
    # notes document, the status endpoint is polled while a guide runs, and
    # nothing in the API ever reads it back — only the worker does, over
    # psycopg. Same reasoning as file_data and crdt_snapshot above.
    notes: Mapped[str] = mapped_column(Text, deferred=True)
    status: Mapped[str] = mapped_column(String, default="pending")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    claimed_at: Mapped[datetime | None] = mapped_column(nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # The guide itself, with each point's citation denormalized onto it.
    # Deferred for the same reason as notes: the poll asks "is it ready yet",
    # and shipping the whole guide on every tick to answer that is how the
    # sources list ran an egress quota to 295%.
    guide: Mapped[dict | None] = mapped_column(JSONB, nullable=True, deferred=True)
    created_at: Mapped[datetime] = mapped_column(default=datetime.utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(nullable=True)


class FlashcardSet(Base):
    """One generated deck. Same queue shape as StudyGuide — see 007.

    A separate table rather than a `kind` column on study_guides: the
    lifecycle is shared but the payload is not, and one JSONB column holding
    either shape would make every reader branch on which it got.
    """

    __tablename__ = "flashcard_sets"

    id: Mapped[uuid.UUID] = uuid_pk()
    document_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("documents.id"))
    requested_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    # Deferred, like study_guides.notes: the whole document, written once by
    # the API and read only by the worker over psycopg.
    notes: Mapped[str] = mapped_column(Text, deferred=True)
    status: Mapped[str] = mapped_column(String, default="pending")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    claimed_at: Mapped[datetime | None] = mapped_column(nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Deferred for the same reason guide is: the status endpoint is polled
    # every two seconds while a deck is running, and shipping every card and
    # every cited excerpt to answer "still working" is exactly the egress
    # mistake infra/README.md documents.
    cards: Mapped[dict | None] = mapped_column(JSONB, nullable=True, deferred=True)
    created_at: Mapped[datetime] = mapped_column(default=datetime.utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(nullable=True)


class Comment(Base):
    """One comment: a thread root when parent_id is NULL, a reply otherwise.

    The first table here that is not a queue — a comment is written by a
    person and read by people, and apps/agent-worker never touches it. See
    006_comments.sql for why roots and replies share a table, and for the
    CHECK constraint that keeps the two shapes from drifting.
    """

    __tablename__ = "comments"

    id: Mapped[uuid.UUID] = uuid_pk()
    document_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("documents.id"))
    author_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("comments.id"), nullable=True
    )
    # NOT deferred, unlike study_guides.notes and sources.file_data.
    #
    # Those are unbounded — a whole document, a whole uploaded file — and the
    # endpoints that poll them do not want them. A comment body is the thing
    # the comments endpoint exists to return, and it is short by nature: there
    # is no version of this list that is useful without the text. Bounding it
    # in the schema (MAX_COMMENT_CHARS) is what keeps the poll cheap instead.
    body: Mapped[str] = mapped_column(Text)
    # Serialized Yjs relative position, roots only. Same shape as
    # suggestions.anchor.
    anchor: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    quote: Mapped[str | None] = mapped_column(Text, nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(nullable=True)
    resolved_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(default=datetime.utcnow)
    edited_at: Mapped[datetime | None] = mapped_column(nullable=True)

    # foreign_keys is required, not optional: this table has two FKs to users
    # (author_id and resolved_by) and SQLAlchemy cannot choose between them.
    author: Mapped["User"] = relationship(foreign_keys=[author_id])
    mentions: Mapped[list["CommentMention"]] = relationship(
        cascade="all, delete-orphan", passive_deletes=True
    )


class CommentMention(Base):
    """Who was @mentioned in a comment, parsed once on write.

    A row rather than a scan of the body: see the note in 006_comments.sql.
    Nothing sends notifications from this — it is what the UI reads to
    highlight a mention.
    """

    __tablename__ = "comment_mentions"

    comment_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("comments.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
