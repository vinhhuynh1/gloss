import base64
import uuid

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from models import Document

router = APIRouter(prefix="/documents", tags=["documents"])

# NOTE: real-time sync itself is NOT handled here — that's the job of the
# y-websocket process the web app connects to directly. This router only
# persists periodic snapshots so the doc survives a server restart and so
# the agent worker has something to read when it retrieves document text.


@router.get("/{document_id}")
def get_document(document_id: uuid.UUID, db: Session = Depends(get_db)):
    doc = db.get(Document, document_id)
    return {
        "id": doc.id,
        "study_space_id": doc.study_space_id,
        "crdt_snapshot": base64.b64encode(doc.crdt_snapshot).decode()
        if doc.crdt_snapshot
        else None,
        "updated_at": doc.updated_at,
    }


class SaveSnapshot(BaseModel):
    crdt_snapshot: str  # base64-encoded Yjs update


@router.put("/{document_id}/snapshot")
def save_snapshot(
    document_id: uuid.UUID, body: SaveSnapshot, db: Session = Depends(get_db)
):
    doc = db.get(Document, document_id)
    doc.crdt_snapshot = base64.b64decode(body.crdt_snapshot)
    db.commit()
    return {"status": "saved"}
