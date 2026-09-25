"""
Generated flashcard decks for a document.

The fourth queue on the same pattern as uploads, checks and guides, and for
the same reason: writing cards needs retrieval, retrieval needs the embedding
model, and that lives only in apps/agent-worker. The API writes a 'pending'
row and the worker picks it up. See infra/migrations/007_flashcards.sql.

Structurally this is routers/study_guides.py with a different noun. That is
deliberate rather than lazy — the status/content split, the open-request
guard and the missing-table dependency are each there for a reason recorded
in that file, and a deck has every one of those reasons too.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session, undefer

from auth import CurrentUser
from authz import require_document
from database import get_db
from models import FlashcardSet
from schemas import CreateFlashcards, FlashcardsOut, FlashcardsStatusOut

# Flipped once the table has been seen, and never checked again. The status
# endpoint is polled by every open editor, and a schema that has grown a table
# does not lose it again.
_table_present = False


def require_flashcards_table(db: Session = Depends(get_db)) -> None:
    """Refuse cleanly when 007 has not been applied yet.

    Same guard, same reasoning and same history as
    require_study_guides_table: the API deploys on a merge while
    infra/migrations is applied by hand, so the code routinely runs for a few
    minutes against a schema that lacks this table. Without the guard the
    first SELECT raises UndefinedTable out of the handler and the browser is
    told only "Failed to fetch".
    """
    global _table_present
    if _table_present:
        return
    if not db.scalar(text("SELECT to_regclass('public.flashcard_sets') IS NOT NULL")):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "Flashcards aren't available yet: the flashcard_sets table is "
                "missing. Apply infra/migrations/007_flashcards.sql, then "
                "re-run infra/supabase/011_lockdown.sql."
            ),
        )
    _table_present = True


router = APIRouter(
    prefix="/documents",
    tags=["flashcards"],
    dependencies=[Depends(require_flashcards_table)],
)

OPEN_STATUSES = ("pending", "processing")

# One at a time per document, like a guide. A deck is a retrieval per section
# followed by one long model call, and a second click while the first is
# running wants the same deck, not a second copy of it.
MAX_OPEN_SETS = 1


def _latest(db: Session, document_id: uuid.UUID) -> FlashcardSet | None:
    """The newest deck for this document, whatever its status — a running one
    is what the editor needs to show, and a failure is something the person
    who asked has to be told rather than being handed the previous success."""
    return db.scalars(
        select(FlashcardSet)
        .where(FlashcardSet.document_id == document_id)
        .order_by(FlashcardSet.created_at.desc())
        .limit(1)
    ).first()


@router.post(
    "/{document_id}/flashcards",
    response_model=FlashcardsStatusOut,
    status_code=status.HTTP_202_ACCEPTED,
)
def create_flashcards(
    document_id: uuid.UUID,
    body: CreateFlashcards,
    user: CurrentUser,
    db: Session = Depends(get_db),
):
    """202: the row exists, the deck does not yet.

    Any member may ask, and the deck belongs to the document rather than to
    whoever clicked — cards made from a shared set of notes are a group
    artifact, and generating them twice because two people wanted them would
    be slower and more expensive for the same output.
    """
    require_document(document_id, user, db)

    open_count = db.scalar(
        select(func.count())
        .select_from(FlashcardSet)
        .where(
            FlashcardSet.document_id == document_id,
            FlashcardSet.status.in_(OPEN_STATUSES),
        )
    )
    if open_count >= MAX_OPEN_SETS:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Flashcards are already being written for this document.",
        )

    deck = FlashcardSet(
        document_id=document_id,
        requested_by=user.id,
        notes=body.notes,
        status="pending",
    )
    db.add(deck)
    db.commit()
    db.refresh(deck)
    return deck


@router.get("/{document_id}/flashcards", response_model=FlashcardsStatusOut)
def get_flashcards_status(
    document_id: uuid.UUID, user: CurrentUser, db: Session = Depends(get_db)
):
    """Is it ready yet. Polled while one is running, so it answers with the
    status columns only — `notes` and `cards` are deferred on the model and
    nothing here touches them."""
    require_document(document_id, user, db)
    deck = _latest(db, document_id)
    if deck is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No flashcards have been generated for this document yet.",
        )
    return deck


@router.get("/{document_id}/flashcards/content", response_model=FlashcardsOut)
def get_flashcards(
    document_id: uuid.UUID, user: CurrentUser, db: Session = Depends(get_db)
):
    """The finished deck, fetched once after the poll reports 'done'.

    Split from the status endpoint rather than being a flag on it so the
    expensive read cannot happen by accident: the deck carries every card and
    every cited excerpt, and this is the one route that asks for it. `undefer`
    names it explicitly for the same reason.
    """
    require_document(document_id, user, db)
    deck = db.scalars(
        select(FlashcardSet)
        .options(undefer(FlashcardSet.cards))
        .where(FlashcardSet.document_id == document_id)
        .order_by(FlashcardSet.created_at.desc())
        .limit(1)
    ).first()
    if deck is None or deck.status != "done":
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No finished flashcards for this document.",
        )
    return deck
