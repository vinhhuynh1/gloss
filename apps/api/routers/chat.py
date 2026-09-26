"""
The space chat: one shared thread per study space for asking about the
course material.

The fifth queue on the pattern uploads, checks, guides and decks set, and for
the same reason: an answer needs retrieval, retrieval needs the embedding
model, and that lives only in apps/agent-worker. Asking writes the question and
a 'pending' answer row together; the worker claims the answer row and streams
the reply into its body. See infra/migrations/009_chat.sql.

Shared, not per person. Everyone in the space reads the same thread, so a
question one member asked on Monday is an answer the rest can find on
Thursday — that is the point of putting it in a group workspace at all.

Reading is split three ways because the thread is polled and only grows:

- no cursor: the latest page, for opening the chat;
- `before`: the page older than that, for "show earlier";
- `since`: only what changed after the newest updated_at the client has seen,
  which while an answer is streaming is that one row.
"""
import uuid
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select, text, update
from sqlalchemy.orm import Session, selectinload, undefer

from auth import CurrentUser
from authz import require_space
from database import get_db
from models import ChatMessage, Document, Source
from schemas import ChatMessageOut, CreateChatMessage

# Flipped once the table has been seen, and never checked again — the same
# device as routers/study_guides.py, for the same reason: the poll below runs
# every second while an answer streams, and a schema does not lose a table.
_table_present = False


def require_chat_table(db: Session = Depends(get_db)) -> None:
    """Refuse cleanly when 009 has not been applied yet. Same guard and same
    history as require_study_guides_table: without it the first SELECT raises
    UndefinedTable and the browser is told only "Failed to fetch"."""
    global _table_present
    if _table_present:
        return
    if not db.scalar(text("SELECT to_regclass('public.chat_messages') IS NOT NULL")):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "Chat isn't available yet: the chat_messages table is missing. "
                "Apply infra/migrations/009_chat.sql, then re-run "
                "infra/supabase/011_lockdown.sql."
            ),
        )
    _table_present = True


router = APIRouter(
    prefix="/study-spaces",
    tags=["chat"],
    dependencies=[Depends(require_chat_table)],
)

OPEN_STATUSES = ("pending", "processing")

# One unanswered question per person: a second question asked before the
# first is answered is almost always a rephrasing of it, and every one is a
# model call. A handful per space, so a busy study group queues rather than
# fanning out into a bill.
MAX_OPEN_PER_PERSON = 1
MAX_OPEN_PER_SPACE = 4

PAGE_SIZE = 40

# How far back the `since` query reaches past the cursor. updated_at comes
# from clock_timestamp() at write time, but a row only becomes visible when
# its transaction commits, so a write stamped just before the cursor can land
# just after the poll that set it. Re-reading a few seconds of overlap costs a
# handful of rows the client de-duplicates by id; missing one would leave an
# answer frozen half-written on screen.
SINCE_OVERLAP = timedelta(seconds=5)


def _out(message: ChatMessage) -> ChatMessageOut:
    return ChatMessageOut(
        id=message.id,
        study_space_id=message.study_space_id,
        role=message.role,
        kind=message.kind,
        author_id=message.author_id,
        author_name=message.author.name if message.author else None,
        reply_to=message.reply_to,
        body=message.body,
        citations=message.citations,
        status=message.status,
        error=message.error,
        created_at=message.created_at,
        updated_at=message.updated_at,
        finished_at=message.finished_at,
        mode=message.mode,
        document_id=message.document_id,
        outline=message.outline,
        applied_at=message.applied_at,
        applied_by=message.applied_by,
        requested_by=message.question.author_id if message.question else None,
    )


# Every read of the thread loads the author and, for answers, the question —
# _out needs both, and lazy loads here would be a query per message.
_LOADS = (selectinload(ChatMessage.author), selectinload(ChatMessage.question))


@router.get("/{space_id}/chat", response_model=list[ChatMessageOut])
def list_chat(
    space_id: uuid.UUID,
    user: CurrentUser,
    db: Session = Depends(get_db),
    since: datetime | None = Query(
        None, description="Only messages changed after this updated_at."
    ),
    before: datetime | None = Query(
        None, description="Only messages created before this created_at."
    ),
):
    """Oldest first, whichever page was asked for."""
    require_space(space_id, user, db)
    if since is not None and before is not None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Pass since or before, not both.",
        )

    query = select(ChatMessage).options(*_LOADS).where(ChatMessage.study_space_id == space_id)

    if since is not None:
        rows = db.scalars(
            query.where(ChatMessage.updated_at > since - SINCE_OVERLAP)
            .order_by(ChatMessage.created_at)
            # A cap, not a page: a client that slept through a burst of
            # activity gets the latest page again on its next full load.
            .limit(PAGE_SIZE * 2)
        ).all()
        return [_out(m) for m in rows]

    if before is not None:
        query = query.where(ChatMessage.created_at < before)
    rows = db.scalars(
        query.order_by(ChatMessage.created_at.desc()).limit(PAGE_SIZE)
    ).all()
    return [_out(m) for m in reversed(rows)]


def _open_counts(db: Session, space_id: uuid.UUID, user_id: uuid.UUID) -> tuple[int, int]:
    """(open answers to this person's questions, open answers in the space)."""
    question = ChatMessage.__table__.alias("question")
    space_count = db.scalar(
        select(func.count())
        .select_from(ChatMessage)
        .where(
            ChatMessage.study_space_id == space_id,
            ChatMessage.status.in_(OPEN_STATUSES),
        )
    )
    mine = db.scalar(
        select(func.count())
        .select_from(ChatMessage)
        .join(question, question.c.id == ChatMessage.reply_to)
        .where(
            ChatMessage.study_space_id == space_id,
            ChatMessage.status.in_(OPEN_STATUSES),
            question.c.author_id == user_id,
        )
    )
    return mine, space_count


@router.post(
    "/{space_id}/chat",
    response_model=list[ChatMessageOut],
    status_code=status.HTTP_202_ACCEPTED,
)
def ask(
    space_id: uuid.UUID,
    body: CreateChatMessage,
    user: CurrentUser,
    db: Session = Depends(get_db),
):
    """202 with [question, answer]: both rows exist, the answer's text does
    not yet. Returned together so the asker sees their question and the
    "thinking" placeholder at once rather than a poll later."""
    require_space(space_id, user, db)

    if body.plan_id is not None:
        return _approve_plan(space_id, body, user, db)

    if body.document_id is not None:
        _require_document_in_space(db, body.document_id, space_id)

    source_ids: list[uuid.UUID] = []
    if body.kind == "notes":
        # De-duplicated in the order given: the notes follow the files in the
        # order they were dropped, which is usually lecture order.
        source_ids = list(dict.fromkeys(body.source_ids))
        if not source_ids:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Choose at least one file to make notes from.",
            )
        found = set(
            db.scalars(
                select(Source.id).where(
                    Source.id.in_(source_ids), Source.study_space_id == space_id
                )
            ).all()
        )
        if len(found) != len(source_ids):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="One of those files is not in this space any more.",
            )

    _check_open(db, space_id, user.id)

    # A plan-mode request is answered with the plan; the notes come later,
    # from _approve_plan.
    kind = "plan" if body.kind == "notes" and body.mode == "plan" else body.kind
    return _create_pair(
        db,
        space_id,
        user.id,
        body.body,
        kind=kind,
        mode=body.mode if body.kind == "notes" else None,
        source_ids=source_ids or None,
        context=body.notes or None,
        document_id=body.document_id if body.kind == "notes" else None,
    )


def _check_open(db: Session, space_id: uuid.UUID, user_id: uuid.UUID) -> None:
    mine, in_space = _open_counts(db, space_id, user_id)
    if mine >= MAX_OPEN_PER_PERSON:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Your last question is still being answered. Wait for it to finish.",
        )
    if in_space >= MAX_OPEN_PER_SPACE:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=(
                f"{in_space} questions are already waiting for an answer in this "
                "space. Try again in a moment."
            ),
        )


def _require_document_in_space(db: Session, document_id: uuid.UUID, space_id: uuid.UUID) -> None:
    doc = db.get(Document, document_id)
    if doc is None or doc.study_space_id != space_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="That document is not in this space.",
        )


def _create_pair(
    db: Session,
    space_id: uuid.UUID,
    user_id: uuid.UUID,
    text_: str,
    **answer_fields,
) -> list[ChatMessageOut]:
    """Write a question and its pending answer, and return both."""
    question = ChatMessage(
        study_space_id=space_id,
        role="user",
        author_id=user_id,
        body=text_,
        status="done",
    )
    db.add(question)
    # Flushed on its own so the question's clock_timestamp() is taken before
    # the answer's — one INSERT with both rows would stamp them together.
    db.flush()
    answer = ChatMessage(
        study_space_id=space_id,
        role="assistant",
        reply_to=question.id,
        status="pending",
        **answer_fields,
    )
    db.add(answer)
    db.commit()

    rows = db.scalars(
        select(ChatMessage)
        .options(*_LOADS)
        .where(ChatMessage.id.in_([question.id, answer.id]))
        .order_by(ChatMessage.created_at)
    ).all()
    return [_out(m) for m in rows]


def _approve_plan(
    space_id: uuid.UUID, body: CreateChatMessage, user, db: Session
) -> list[ChatMessageOut]:
    """Write the notes a plan describes, following the outline as edited.

    The plan is marked approved in the same transaction as the notes request
    is written, by an UPDATE that only matches an unapproved plan: two people
    clicking Write notes on the same plan get one set of notes and one 409.
    Files, document and existing-notes context come from the plan, so what is
    approved is exactly what was planned.
    """
    if not body.outline:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Keep at least one section of the plan.",
        )
    _check_open(db, space_id, user.id)

    plan = db.scalars(
        select(ChatMessage)
        .options(undefer(ChatMessage.context))
        .where(
            ChatMessage.id == body.plan_id,
            ChatMessage.study_space_id == space_id,
            ChatMessage.kind == "plan",
            ChatMessage.status == "done",
        )
    ).first()
    if plan is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="That plan is not in this space, or is not finished yet.",
        )

    claimed = db.execute(
        update(ChatMessage)
        .where(ChatMessage.id == plan.id, ChatMessage.applied_at.is_(None))
        .values(
            applied_at=func.now(),
            applied_by=user.id,
            updated_at=func.clock_timestamp(),
        )
    )
    if claimed.rowcount == 0:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Notes have already been written from this plan.",
        )

    return _create_pair(
        db,
        space_id,
        user.id,
        body.body,
        kind="notes",
        mode="plan",
        source_ids=plan.source_ids,
        # The document as it reads now if the client sent it, since the group
        # may have written more while the plan was being reviewed.
        context=body.notes or plan.context,
        document_id=plan.document_id,
        outline=[section.model_dump() for section in body.outline],
    )


@router.post(
    "/{space_id}/chat/{message_id}/retry",
    response_model=ChatMessageOut,
    status_code=status.HTTP_202_ACCEPTED,
)
def retry(
    space_id: uuid.UUID,
    message_id: uuid.UUID,
    user: CurrentUser,
    db: Session = Depends(get_db),
):
    """Put a failed answer back on the queue.

    Any member may, not only whoever asked: the thread is shared, and the
    person who wants the answer now may not be the person who asked. attempts
    resets to zero so the worker's MAX_ATTEMPTS applies afresh, the same as a
    retried upload in routers/sources.py.
    """
    require_space(space_id, user, db)
    result = db.execute(
        update(ChatMessage)
        .where(
            ChatMessage.id == message_id,
            ChatMessage.study_space_id == space_id,
            ChatMessage.role == "assistant",
            ChatMessage.status == "failed",
        )
        .values(
            status="pending",
            attempts=0,
            error=None,
            body="",
            citations=None,
            claimed_at=None,
            finished_at=None,
            updated_at=func.clock_timestamp(),
        )
    )
    if result.rowcount == 0:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Only a failed answer can be retried.",
        )
    db.commit()
    message = db.scalars(
        select(ChatMessage).options(*_LOADS).where(ChatMessage.id == message_id)
    ).one()
    return _out(message)


@router.post("/{space_id}/chat/{message_id}/apply", response_model=ChatMessageOut)
def claim_apply(
    space_id: uuid.UUID,
    message_id: uuid.UUID,
    user: CurrentUser,
    db: Session = Depends(get_db),
):
    """Claim the right to insert finished notes into the document.

    Called by the browser just before it inserts, and it inserts only on a 200.
    Auto and plan notes are inserted by the asker's browser without a click,
    and the asker may have the space open in two tabs; manual Insert can be
    clicked by anyone. The conditional UPDATE is what makes "inserted once"
    true across all of them — the second claim gets a 409 and does nothing.
    """
    require_space(space_id, user, db)
    result = db.execute(
        update(ChatMessage)
        .where(
            ChatMessage.id == message_id,
            ChatMessage.study_space_id == space_id,
            ChatMessage.kind == "notes",
            ChatMessage.status == "done",
            ChatMessage.applied_at.is_(None),
        )
        .values(applied_at=func.now(), applied_by=user.id, updated_at=func.clock_timestamp())
    )
    if result.rowcount == 0:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="These notes have already been added to the document.",
        )
    db.commit()
    message = db.scalars(
        select(ChatMessage).options(*_LOADS).where(ChatMessage.id == message_id)
    ).one()
    return _out(message)


@router.delete("/{space_id}/chat/{message_id}/apply", status_code=status.HTTP_204_NO_CONTENT)
def release_apply(
    space_id: uuid.UUID,
    message_id: uuid.UUID,
    user: CurrentUser,
    db: Session = Depends(get_db),
):
    """Give a claim back when the insert it was for failed — the editor went
    away between the claim and the insert, say — so the notes are not marked
    added when they are not. Only the claimant's own claim."""
    require_space(space_id, user, db)
    db.execute(
        update(ChatMessage)
        .where(
            ChatMessage.id == message_id,
            ChatMessage.study_space_id == space_id,
            ChatMessage.kind == "notes",
            ChatMessage.applied_by == user.id,
        )
        .values(applied_at=None, applied_by=None, updated_at=func.clock_timestamp())
    )
    db.commit()
