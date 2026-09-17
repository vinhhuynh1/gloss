import base64
import uuid

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from auth import CurrentUser
from authz import require_document
from database import get_db
from schemas import DocumentWithSnapshotOut

router = APIRouter(prefix="/documents", tags=["documents"])

# NOTE: real-time sync itself is NOT handled here — that's the job of the
# apps/realtime process the web app connects to directly. This router only
# persists periodic snapshots so the doc survives a server restart and so
# the agent worker has something to read when it retrieves document text.
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
