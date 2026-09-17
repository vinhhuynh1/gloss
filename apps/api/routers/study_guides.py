"""
Generated study guides for a document.

A third queue on the same pattern as uploads and checks, and for the same
reason: writing a guide needs retrieval, retrieval needs the embedding model,
and that lives only in apps/agent-worker. The API writes a 'pending' row and
the worker picks it up. See infra/migrations/005_study_guides.sql.

The notes arrive in the request body rather than being read from
documents.crdt_snapshot. That column holds a Yjs update and nothing in Python
can decode one — apps/realtime is the only process in the stack that can, and
it is a Node service. The browser already has the document, so it sends the
text, exactly as it does for a "check this passage" request.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session, undefer

from auth import CurrentUser
from authz import require_document
from database import get_db
from models import StudyGuide
from schemas import CreateStudyGuide, StudyGuideOut, StudyGuideStatusOut

router = APIRouter(prefix="/documents", tags=["study-guides"])

OPEN_STATUSES = ("pending", "processing")

# One at a time, per person per document. A guide is the most expensive thing
# the worker does — a retrieval per section, then one long model call — and a
# second click while the first is still running wants the same answer, not a
# second copy of it.
MAX_OPEN_GUIDES = 1


def _latest(db: Session, document_id: uuid.UUID) -> StudyGuide | None:
    """The newest guide for this document, whatever its status.

    Newest rather than newest-done: a guide still running is what the editor
    needs to show, and a failure is something the person who asked has to be
    told about rather than being shown the previous success as though nothing
    happened.
    """
    return db.scalars(
        select(StudyGuide)
        .where(StudyGuide.document_id == document_id)
        .order_by(StudyGuide.created_at.desc())
        .limit(1)
    ).first()


@router.post(
    "/{document_id}/study-guide",
    response_model=StudyGuideStatusOut,
    status_code=status.HTTP_202_ACCEPTED,
)
def create_study_guide(
    document_id: uuid.UUID,
    body: CreateStudyGuide,
    user: CurrentUser,
    db: Session = Depends(get_db),
):
    """
    202, like an upload or a check: the row exists, the guide does not yet.

    Any member may ask, and the result belongs to the document rather than to
    the person who clicked — a study guide for a shared set of notes is a group
    artifact, and generating it twice because two people wanted one would be
    both slower and more expensive for the same output.
    """
    require_document(document_id, user, db)

    open_count = db.scalar(
        select(func.count())
        .select_from(StudyGuide)
        .where(
            StudyGuide.document_id == document_id,
            StudyGuide.status.in_(OPEN_STATUSES),
        )
    )
    if open_count >= MAX_OPEN_GUIDES:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A study guide is already being written for this document.",
        )

    guide = StudyGuide(
        document_id=document_id,
        requested_by=user.id,
        notes=body.notes,
        status="pending",
    )
    db.add(guide)
    db.commit()
    db.refresh(guide)
    return guide


@router.get("/{document_id}/study-guide", response_model=StudyGuideStatusOut)
def get_study_guide_status(
    document_id: uuid.UUID, user: CurrentUser, db: Session = Depends(get_db)
):
    """Is it ready yet. Polled while one is running, so it answers with the
    status columns only — `notes` and `guide` are deferred on the model and
    nothing here touches them."""
    require_document(document_id, user, db)
    guide = _latest(db, document_id)
    if guide is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No study guide has been generated for this document yet.",
        )
    return guide


@router.get("/{document_id}/study-guide/content", response_model=StudyGuideOut)
def get_study_guide(
    document_id: uuid.UUID, user: CurrentUser, db: Session = Depends(get_db)
):
    """The finished guide, fetched once after the poll reports 'done'.

    Split from the status endpoint rather than a flag on it so the expensive
    read cannot happen by accident: the guide is a JSONB document of every
    point and every cited excerpt, and this is the one route that asks for it.
    `undefer` names it explicitly for the same reason.
    """
    require_document(document_id, user, db)
    guide = db.scalars(
        select(StudyGuide)
        .options(undefer(StudyGuide.guide))
        .where(StudyGuide.document_id == document_id)
        .order_by(StudyGuide.created_at.desc())
        .limit(1)
    ).first()
    if guide is None or guide.status != "done":
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No finished study guide for this document.",
        )
    return guide
