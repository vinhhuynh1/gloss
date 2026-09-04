import uuid
from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import ForeignKey, LargeBinary, String, Text
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
    source_chunk_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("source_chunks.id"), nullable=True
    )
    status: Mapped[str] = mapped_column(String, default="pending")
    created_at: Mapped[datetime] = mapped_column(default=datetime.utcnow)
    resolved_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id"), nullable=True
    )
    resolved_at: Mapped[datetime | None] = mapped_column(nullable=True)

    document: Mapped["Document"] = relationship(back_populates="suggestions")
