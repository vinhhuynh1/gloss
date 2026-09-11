"""
"Check this passage" requests from the editor.

The API cannot answer these itself: grounding a suggestion needs retrieval,
retrieval needs the embedding model, and that lives only in
apps/agent-worker. So a request is a queued row, exactly like an upload — the
worker claims it, runs the agent, and writes the suggestion — and the editor
polls the list endpoint below until it finishes.
"""
import json
import uuid
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from auth import CurrentUser
from authz import require_document
from database import get_db
from models import AgentRequest
from schemas import AgentRequestOut, CreateAgentRequest

router = APIRouter(prefix="/documents", tags=["agent-requests"])

# Per person, per document. Every request is a model call someone pays for,
# and a held-down shortcut or a double-click should not queue a dozen of them.
# Three still lets someone check a few passages in a row without waiting.
MAX_OPEN_REQUESTS = 3

# How long a finished request stays in the list. Long enough for the editor to
# see the outcome on its next poll even after a slow tab wakes up; short
# enough that the list stays "what I'm waiting on", not a history.
RECENT_WINDOW = timedelta(minutes=10)

# A relative position is a handful of integers. Anything much bigger than
# this is not an anchor, and the column is not somewhere to store it.
MAX_ANCHOR_BYTES = 4096

OPEN_STATUSES = ("pending", "processing")


def _check_anchor(anchor: dict) -> None:
    missing = [key for key in ("from", "to") if not isinstance(anchor.get(key), dict)]
    if missing:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"anchor is missing {', '.join(missing)}",
        )
    if len(json.dumps(anchor)) > MAX_ANCHOR_BYTES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="anchor is too large",
        )


@router.post(
    "/{document_id}/agent-requests",
    response_model=AgentRequestOut,
    status_code=status.HTTP_202_ACCEPTED,
)
def create_agent_request(
    document_id: uuid.UUID,
    body: CreateAgentRequest,
    user: CurrentUser,
    db: Session = Depends(get_db),
):
    """
    202, like an upload: the row exists, the answer does not yet.

    Any member may ask. The result is a suggestion the whole group sees and
    any member can accept or reject — asking is not the same as deciding.
    """
    require_document(document_id, user, db)
    _check_anchor(body.anchor)

    open_count = db.scalar(
        select(func.count())
        .select_from(AgentRequest)
        .where(
            AgentRequest.document_id == document_id,
            AgentRequest.requested_by == user.id,
            AgentRequest.status.in_(OPEN_STATUSES),
        )
    )
    if open_count >= MAX_OPEN_REQUESTS:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=(
                f"You already have {open_count} checks running on this document. "
                "Wait for one to finish."
            ),
        )

    request = AgentRequest(
        document_id=document_id,
        requested_by=user.id,
        passage=body.passage,
        anchor=body.anchor,
        status="pending",
    )
    db.add(request)
    db.commit()
    db.refresh(request)
    return request


@router.get("/{document_id}/agent-requests", response_model=list[AgentRequestOut])
def list_agent_requests(
    document_id: uuid.UUID, user: CurrentUser, db: Session = Depends(get_db)
):
    """The caller's own requests on this document: everything still open,
    plus anything that finished recently.

    Only the caller's. A collaborator does not need a spinner for someone
    else's question — they see the answer when it lands as a suggestion.
    """
    require_document(document_id, user, db)
    return db.scalars(
        select(AgentRequest)
        .where(
            AgentRequest.document_id == document_id,
            AgentRequest.requested_by == user.id,
            or_(
                AgentRequest.status.in_(OPEN_STATUSES),
                AgentRequest.finished_at > func.now() - RECENT_WINDOW,
            ),
        )
        .order_by(AgentRequest.created_at)
    ).all()
