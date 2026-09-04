import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from auth import CurrentUser, require_agent
from authz import require_document
from database import get_db
from models import Suggestion
from schemas import SuggestionOut

router = APIRouter(prefix="/suggestions", tags=["suggestions"])


class CreateSuggestion(BaseModel):
    document_id: uuid.UUID
    type: str  # citation | contradiction | gap_fill
    anchor: dict  # serialized Yjs relative position, opaque to the API
    proposed_text: str
    source_chunk_id: uuid.UUID | None = None


@router.post(
    "",
    response_model=SuggestionOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_agent)],
)
def create_suggestion(body: CreateSuggestion, db: Session = Depends(get_db)):
    """
    Called by the agent worker, never by a human client directly.

    Authenticated with the shared AGENT_SERVICE_TOKEN rather than a user JWT —
    there is no human session behind an agent pass. See auth.require_agent.
    """
    suggestion = Suggestion(**body.model_dump())
    db.add(suggestion)
    db.commit()
    db.refresh(suggestion)
    return suggestion


@router.get("/document/{document_id}", response_model=list[SuggestionOut])
def list_pending_suggestions(
    document_id: uuid.UUID, user: CurrentUser, db: Session = Depends(get_db)
):
    require_document(document_id, user, db)
    return db.scalars(
        select(Suggestion)
        .where(Suggestion.document_id == document_id, Suggestion.status == "pending")
        .order_by(Suggestion.created_at)
    ).all()


class ResolveSuggestion(BaseModel):
    # No resolved_by: it comes from the caller's token. Accepting it from the
    # body let any client record a decision as any user.
    accept: bool


@router.post("/{suggestion_id}/resolve", response_model=SuggestionOut)
def resolve_suggestion(
    suggestion_id: uuid.UUID,
    body: ResolveSuggestion,
    user: CurrentUser,
    db: Session = Depends(get_db),
):
    """
    Flips the suggestion's status. Applying an ACCEPTED suggestion's text
    into the shared document is done client-side via a normal Yjs insert
    at the suggestion's anchor — this endpoint just records the decision,
    it does not touch document content.
    """
    suggestion = db.get(Suggestion, suggestion_id)
    if suggestion is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Suggestion not found"
        )

    require_document(suggestion.document_id, user, db)

    suggestion.status = "accepted" if body.accept else "rejected"
    suggestion.resolved_by = user.id
    suggestion.resolved_at = datetime.utcnow()
    db.commit()
    db.refresh(suggestion)
    return suggestion
