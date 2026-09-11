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
    # Latest Yjs document state. The API treats this as an opaque blob —
    # only the frontend (via Yjs) and the agent worker's retrieval step
    # ever need to interpret it.
    #
    # WRITER OF RECORD: apps/realtime. It flushes here on a debounce and on
    # shutdown. PUT /documents/{id}/snapshot writes the same column and is a
    # second writer — see the note in routers/documents.py.
    crdt_snapshot: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(default=datetime.utcnow)

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
    # The uploaded bytes, kept so the corpus can be re-chunked later.
    # Deliberately NOT in SourceOut — see schemas.py.
    file_data: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
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
