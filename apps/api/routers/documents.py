import base64
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from auth import CurrentUser
from authz import require_document
from database import get_db
from models import Document
from schemas import DocumentOut, DocumentWithSnapshotOut, RenameDocument

router = APIRouter(prefix="/documents", tags=["documents"])

# NOTE: real-time sync itself is NOT handled here — that's the job of the
# apps/realtime process the web app connects to directly. This router only
# persists periodic snapshots so the doc survives a server restart.
#
# Not for the agent worker's benefit: it never reads this column. Decoding a
# Yjs update needs a CRDT library, and neither Python service carries one, so
# every feature that works from document text — a check, a study guide — is
# sent that text by the browser instead.
#
# WRITER OF RECORD: apps/realtime owns documents.crdt_snapshot. It binds
# state on first connection and flushes on a debounce and on SIGTERM. The
# PUT below writes the same column, so it is a second writer — use it only
# as a client-side fallback, never concurrently with an open realtime
# session, or one will clobber the other's newer state.


@router.get("/{document_id}", response_model=DocumentWithSnapshotOut)
def get_document(
    document_id: uuid.UUID, user: CurrentUser, db: Session = Depends(get_db)
):
    doc = require_document(document_id, user, db)
    # crdt_snapshot is deferred (models.py), so reading it here costs a second
    # round trip — `SELECT crdt_snapshot FROM documents WHERE id = ...`, which
    # is the narrowest query that could answer this. That is the right side of
    # the trade: this is the only endpoint in the API that wants the blob, and
    # the web app never calls it. Undeferring in the query instead would not
    # work anyway — require_document has already put the row in the session's
    # identity map, and a second SELECT without populate_existing returns the
    # object as it stands and applies no loader options to it.
    return DocumentWithSnapshotOut(
        id=doc.id,
        study_space_id=doc.study_space_id,
        crdt_snapshot=base64.b64encode(doc.crdt_snapshot).decode()
        if doc.crdt_snapshot
        else None,
        updated_at=doc.updated_at,
    )


class SaveSnapshot(BaseModel):
    crdt_snapshot: str  # base64-encoded Yjs update


@router.put("/{document_id}/snapshot")
def save_snapshot(
    document_id: uuid.UUID,
    body: SaveSnapshot,
    user: CurrentUser,
    db: Session = Depends(get_db),
):
    doc = require_document(document_id, user, db)
    # Assigning a deferred attribute does not load it first, so this stays a
    # pure write — it no longer reads the old snapshot back just to replace it.
    doc.crdt_snapshot = base64.b64decode(body.crdt_snapshot)
    db.commit()
    return {"status": "saved"}


@router.patch("/{document_id}", response_model=DocumentOut)
def rename_document(
    document_id: uuid.UUID,
    body: RenameDocument,
    user: CurrentUser,
    db: Session = Depends(get_db),
):
    """Rename a document. Any member, like creating one — the title is a label
    on shared work, not a claim of ownership."""
    doc = require_document(document_id, user, db)
    doc.title = body.title
    db.commit()
    db.refresh(doc)
    return doc


@router.delete("/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_document(
    document_id: uuid.UUID, user: CurrentUser, db: Session = Depends(get_db)
):
    """Delete a document and everything anchored to it.

    The foreign keys cascade: suggestions, agent_requests, study_guides,
    flashcard_sets and comments all go with it. That is a lot to lose on a
    misclick, so the UI confirms first.

    A space must keep at least one document. Without this the editor would
    have nothing to open and the next visitor would silently get a fresh
    empty one from _first_document, which reads as "my notes are gone"
    rather than as "the last document cannot be deleted".
    """
    doc = require_document(document_id, user, db)
    remaining = db.query(Document).filter(
        Document.study_space_id == doc.study_space_id
    ).count()
    if remaining <= 1:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A study space needs at least one document.",
        )
    db.delete(doc)
    db.commit()
