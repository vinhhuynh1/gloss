import uuid
from datetime import datetime

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from models import Suggestion

router = APIRouter(prefix="/suggestions", tags=["suggestions"])


class CreateSuggestion(BaseModel):
    document_id: uuid.UUID
    type: str  # citation | contradiction | gap_fill
    anchor: dict  # serialized Yjs relative position, opaque to the API
    proposed_text: str
    source_chunk_id: uuid.UUID | None = None


@router.post("")
def create_suggestion(body: CreateSuggestion, db: Session = Depends(get_db)):
    """Called by the agent worker, never by a human client directly."""
    suggestion = Suggestion(**body.model_dump())
    db.add(suggestion)
    db.commit()
    db.refresh(suggestion)
    return suggestion


@router.get("/document/{document_id}")
def list_pending_suggestions(document_id: uuid.UUID, db: Session = Depends(get_db)):
    return (
        db.query(Suggestion)
        .filter_by(document_id=document_id, status="pending")
        .order_by(Suggestion.created_at)
        .all()
    )


class ResolveSuggestion(BaseModel):
    resolved_by: uuid.UUID
    accept: bool


@router.post("/{suggestion_id}/resolve")
def resolve_suggestion(
    suggestion_id: uuid.UUID, body: ResolveSuggestion, db: Session = Depends(get_db)
):
    """
    Flips the suggestion's status. Applying an ACCEPTED suggestion's text
    into the shared document is done client-side via a normal Yjs insert
    at the suggestion's anchor — this endpoint just records the decision,
    it does not touch document content.
    """
    suggestion = db.get(Suggestion, suggestion_id)
    suggestion.status = "accepted" if body.accept else "rejected"
    suggestion.resolved_by = body.resolved_by
    suggestion.resolved_at = datetime.utcnow()
    db.commit()
    return suggestion
