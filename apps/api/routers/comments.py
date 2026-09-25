"""
Comment threads anchored to a passage in the notes.

The first feature here that does not involve the agent at all. Uploads, checks
and guides are queues the worker drains; a comment is written by a person and
read by people, so this router owns the whole lifecycle and nothing in
apps/agent-worker ever touches these tables.

Authorization is study-space membership, exactly as everywhere else — comments
have no ACL of their own, so anyone who can open the document can read and
write its comments. Editing and deleting are narrower: those are the author's
alone.

Anchors are the same serialized Yjs relative positions the agent uses
(apps/web/src/lib/anchors.ts), opaque here and resolvable only by the editor.
That is what lets a comment stay attached to its sentence while collaborators
edit around it.
"""
import json
import re
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, text
from sqlalchemy.orm import Session, selectinload

from auth import CurrentUser
from authz import require_document
from database import get_db
from models import Comment, CommentMention, StudySpaceMember, User
from schemas import CommentOut, CreateComment, CreateReply, UpdateComment

# Flipped once the table has been seen, and never checked again — the same
# device as routers/study_guides.py. The comments list is polled by every open
# editor, and a schema that has grown a table does not lose it again.
_table_present = False


def require_comments_table(db: Session = Depends(get_db)) -> None:
    """Refuse cleanly when 006 has not been applied yet.

    The API deploys on a merge to main while infra/migrations is applied by
    hand, so the code routinely runs for a few minutes against a schema
    without this table. Without this guard the first SELECT raises
    UndefinedTable out of the handler, the response dies mid-flight, and the
    platform's own 503 arrives with none of the CORS headers — which the
    browser reports as a bare "Failed to fetch". See the longer note on
    require_study_guides_table; this is the same failure and the same fix.
    """
    global _table_present
    if _table_present:
        return
    if not db.scalar(text("SELECT to_regclass('public.comments') IS NOT NULL")):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "Comments aren't available yet: the comments table is missing. "
                "Apply infra/migrations/006_comments.sql, then re-run "
                "infra/supabase/011_lockdown.sql."
            ),
        )
    _table_present = True


router = APIRouter(
    prefix="/documents",
    tags=["comments"],
    dependencies=[Depends(require_comments_table)],
)

# A relative position is a handful of integers. Same bound, same reasoning as
# agent_requests.py.
MAX_ANCHOR_BYTES = 4096

# @ followed by an address. Mentions are inserted by the composer as the
# member's email, which is the only identifier a client reliably has for
# another person — display names are neither unique nor stable.
#
# The domain must both start and end with an alphanumeric, which is what
# keeps a sentence-ending period out of the address: "@ada@test.local." is a
# mention of ada@test.local, not of "test.local.". Spelling that as a lazy run
# with a punctuation lookahead instead looks equivalent and is not — the "."
# in the terminator class ends the match at the first dot, so every dotted
# domain resolved to nothing and no real address could ever be mentioned.
MENTION_RE = re.compile(r"@([^@\s]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)")


def _now() -> datetime:
    """datetime.utcnow(), not sqlalchemy.func.now().

    created_at defaults to the Python clock on every model in models.py.
    Setting edited_at and resolved_at from the database clock instead would
    put naive and server-generated timestamps in neighbouring columns and
    make "edited before it was created" possible across a clock skew.
    """
    return datetime.utcnow()


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


def _resolve_mentions(
    db: Session, space_id: uuid.UUID, body: str
) -> list[uuid.UUID]:
    """User ids for the @addresses in this body, restricted to space members.

    Restricted deliberately. An address that is not a member is someone who
    cannot open the document, so a mention of them is at best a typo and at
    worst a way to probe which addresses have accounts. Unmatched mentions are
    dropped silently rather than rejected — a comment is prose, and refusing
    to save it over a stray @ would be worse than rendering that @ as text.
    """
    addresses = {m.group(1).lower() for m in MENTION_RE.finditer(body)}
    if not addresses:
        return []
    rows = db.execute(
        select(User.id)
        .join(StudySpaceMember, StudySpaceMember.user_id == User.id)
        .where(
            StudySpaceMember.study_space_id == space_id,
            User.email.in_(addresses),
        )
    ).all()
    return [r[0] for r in rows]


def _out(comment: Comment) -> CommentOut:
    """Flatten the author relationship into the wire shape.

    The sidebar renders a name against every comment, and doing that from
    author_id alone would be one request per comment.
    """
    return CommentOut(
        id=comment.id,
        document_id=comment.document_id,
        parent_id=comment.parent_id,
        author_id=comment.author_id,
        author_name=comment.author.name,
        author_email=comment.author.email,
        body=comment.body,
        anchor=comment.anchor,
        quote=comment.quote,
        resolved_at=comment.resolved_at,
        resolved_by=comment.resolved_by,
        created_at=comment.created_at,
        edited_at=comment.edited_at,
        mentioned_user_ids=[m.user_id for m in comment.mentions],
    )


def _load(db: Session, comment_id: uuid.UUID) -> Comment:
    comment = db.scalars(
        select(Comment)
        .options(selectinload(Comment.author), selectinload(Comment.mentions))
        .where(Comment.id == comment_id)
    ).first()
    if comment is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Comment not found"
        )
    return comment


@router.get("/{document_id}/comments", response_model=list[CommentOut])
def list_comments(
    document_id: uuid.UUID, user: CurrentUser, db: Session = Depends(get_db)
):
    """Every comment on the document, roots and replies together.

    One request rather than a list of roots plus one per thread: a document's
    comments are small and bounded (MAX_COMMENT_CHARS each), and the editor
    needs all of them anyway to draw the highlights. The client groups by
    parent_id.

    Resolved threads are included. They stop being highlighted in the
    document, but "show resolved" is a filter the sidebar offers, and fetching
    them again on toggle would be a second round trip for data this small.
    """
    require_document(document_id, user, db)
    comments = db.scalars(
        select(Comment)
        .options(selectinload(Comment.author), selectinload(Comment.mentions))
        .where(Comment.document_id == document_id)
        .order_by(Comment.created_at)
    ).all()
    return [_out(c) for c in comments]


@router.post(
    "/{document_id}/comments",
    response_model=CommentOut,
    status_code=status.HTTP_201_CREATED,
)
def create_comment(
    document_id: uuid.UUID,
    body: CreateComment,
    user: CurrentUser,
    db: Session = Depends(get_db),
):
    """Open a thread on a passage. 201, not 202 — nothing is queued."""
    document = require_document(document_id, user, db)
    _check_anchor(body.anchor)

    comment = Comment(
        document_id=document_id,
        author_id=user.id,
        body=body.body,
        anchor=body.anchor,
        quote=body.quote or None,
    )
    db.add(comment)
    db.flush()  # assigns comment.id, which the mention rows need

    for user_id in _resolve_mentions(db, document.study_space_id, body.body):
        db.add(CommentMention(comment_id=comment.id, user_id=user_id))

    db.commit()
    return _out(_load(db, comment.id))


@router.post(
    "/{document_id}/comments/{comment_id}/replies",
    response_model=CommentOut,
    status_code=status.HTTP_201_CREATED,
)
def create_reply(
    document_id: uuid.UUID,
    comment_id: uuid.UUID,
    body: CreateReply,
    user: CurrentUser,
    db: Session = Depends(get_db),
):
    """Reply to a thread. Any member may reply, including to someone else's."""
    document = require_document(document_id, user, db)
    parent = _load(db, comment_id)

    if parent.document_id != document_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Comment not found"
        )
    # One level, not a tree. Threads that nest are harder to read in a 320px
    # rail than they are useful, and the CHECK constraint in 006 assumes a
    # reply's parent is a root.
    if parent.parent_id is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Replies go on the thread, not on another reply.",
        )

    reply = Comment(
        document_id=document_id,
        author_id=user.id,
        parent_id=comment_id,
        body=body.body,
    )
    db.add(reply)
    db.flush()

    for user_id in _resolve_mentions(db, document.study_space_id, body.body):
        db.add(CommentMention(comment_id=reply.id, user_id=user_id))

    db.commit()
    return _out(_load(db, reply.id))


@router.patch("/{document_id}/comments/{comment_id}", response_model=CommentOut)
def update_comment(
    document_id: uuid.UUID,
    comment_id: uuid.UUID,
    body: UpdateComment,
    user: CurrentUser,
    db: Session = Depends(get_db),
):
    """Edit your own comment.

    Author-only, unlike resolving. Membership is enough to decide a thread is
    finished; it is not enough to put words in someone else's mouth.
    """
    document = require_document(document_id, user, db)
    comment = _load(db, comment_id)
    if comment.document_id != document_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Comment not found"
        )
    if comment.author_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the author can edit a comment",
        )

    comment.body = body.body
    comment.edited_at = _now()

    # Mentions are derived from the body, so an edit replaces them outright
    # rather than merging — otherwise removing a name from the text would
    # leave the mention behind.
    db.query(CommentMention).filter(CommentMention.comment_id == comment.id).delete()
    for user_id in _resolve_mentions(db, document.study_space_id, body.body):
        db.add(CommentMention(comment_id=comment.id, user_id=user_id))

    db.commit()
    return _out(_load(db, comment.id))


@router.post("/{document_id}/comments/{comment_id}/resolve", response_model=CommentOut)
def resolve_comment(
    document_id: uuid.UUID,
    comment_id: uuid.UUID,
    user: CurrentUser,
    resolved: bool = True,
    db: Session = Depends(get_db),
):
    """Mark a thread resolved, or reopen it.

    Any member, not just the author: a question someone else answered is
    resolved by whoever read the answer, and requiring the asker to come back
    and tick it is how comment threads rot.
    """
    require_document(document_id, user, db)
    comment = _load(db, comment_id)
    if comment.document_id != document_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Comment not found"
        )
    if comment.parent_id is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Resolve the thread, not one of its replies.",
        )

    comment.resolved_at = _now() if resolved else None
    comment.resolved_by = user.id if resolved else None
    db.commit()
    return _out(_load(db, comment.id))


@router.delete(
    "/{document_id}/comments/{comment_id}", status_code=status.HTTP_204_NO_CONTENT
)
def delete_comment(
    document_id: uuid.UUID,
    comment_id: uuid.UUID,
    user: CurrentUser,
    db: Session = Depends(get_db),
):
    """Delete your own comment. Deleting a root takes its replies with it —
    the FK in 006_comments.sql cascades, which is what "delete this thread"
    has to mean."""
    require_document(document_id, user, db)
    comment = _load(db, comment_id)
    if comment.document_id != document_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Comment not found"
        )
    if comment.author_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the author can delete a comment",
        )
    db.delete(comment)
    db.commit()
