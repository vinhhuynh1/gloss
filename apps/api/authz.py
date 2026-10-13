"""
Membership checks.

`study_space_members` has existed in the schema since the first commit and
was read by nothing — every endpoint trusted ids supplied in the request. The
helpers here are the single place that changes.

Both raise 404 for "no such thing" and 403 for "exists, but not yours".
Distinguishing them leaks the existence of a space to a non-member, which is
the right trade here: study spaces are invited-into by uuid, not enumerable,
and a 404-for-everything API is materially harder to debug.
"""
import uuid

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from models import (
    AgentRequest,
    ChatMessage,
    Document,
    Quiz,
    Source,
    StudyGuide,
    StudySpace,
    StudySpaceMember,
    User,
)

OWNER_ONLY = ("owner",)
ANY_MEMBER = ("owner", "member")


def _forbidden() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="You are not a member of this study space",
    )


def require_space(
    space_id: uuid.UUID,
    user: User,
    db: Session,
    *,
    roles: tuple[str, ...] = ANY_MEMBER,
) -> StudySpace:
    space = db.get(StudySpace, space_id)
    if space is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Study space not found"
        )

    membership = db.get(StudySpaceMember, (space_id, user.id))
    if membership is None:
        raise _forbidden()
    if membership.role not in roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This action requires the study space owner",
        )
    return space


def require_document(document_id: uuid.UUID, user: User, db: Session) -> Document:
    """
    Document access is derived from study-space membership — documents have no
    ACL of their own. One join rather than a load-then-check, so this stays a
    single round trip on the hot path (the sidebar polls it).
    """
    doc = db.get(Document, document_id)
    if doc is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Document not found"
        )

    membership = db.get(StudySpaceMember, (doc.study_space_id, user.id))
    if membership is None:
        raise _forbidden()
    return doc


def require_source(source_id: uuid.UUID, user: User, db: Session) -> Source:
    """
    Same shape as require_document: a source belongs to a study space, and
    study-space membership is the only ACL. Kept here rather than inlined in
    the router so "who may touch this row" stays answerable from one file.
    """
    source = db.get(Source, source_id)
    if source is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Source not found"
        )

    membership = db.get(StudySpaceMember, (source.study_space_id, user.id))
    if membership is None:
        raise _forbidden()
    return source


def require_quiz(quiz_id: uuid.UUID, user: User, db: Session) -> Quiz:
    """
    A quiz looked up by its own id, for the practice routes and attempts.

    404 for everything, unlike the helpers above. A practice quiz is one
    person's results in the making, and answering 403 to a groupmate would
    tell them it exists. A non-member gets the same 404, so "not yours" and
    "not there" cannot be told apart from outside.
    """
    not_found = HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Quiz not found")
    quiz = db.get(Quiz, quiz_id)
    if quiz is None:
        raise not_found
    if quiz.personal_for is not None and quiz.personal_for != user.id:
        raise not_found
    space_id = db.scalar(select(Document.study_space_id).where(Document.id == quiz.document_id))
    if db.get(StudySpaceMember, (space_id, user.id)) is None:
        raise not_found
    return quiz


# Demo mode: (allowance, plural label for the message). The one place to
# change a limit. See docs/superpowers/specs/2026-10-13-demo-mode-design.md.
GUEST_LIMITS: dict[str, tuple[int, str]] = {
    "check": (5, "checks"),
    "chat": (3, "chat questions"),
    "study_guide": (1, "study guides"),
    "quiz": (1, "quizzes"),
}


def _demo_started_at(user: User, db: Session):
    return db.scalar(
        select(func.min(StudySpace.created_at))
        .join(StudySpaceMember, StudySpaceMember.study_space_id == StudySpace.id)
        .where(StudySpaceMember.user_id == user.id, StudySpace.is_demo)
    )


def require_quota(user: User, kind: str, db: Session) -> None:
    """429 once a guest has used their allowance for `kind`.

    Counts every row the guest created after their sandbox was copied,
    whatever its status — so re-asking after a failure cannot get around the
    cap — and never the rows the copy brought over, which keep the template's
    older created_at. Normal users return immediately."""
    if not user.is_guest:
        return
    limit, label = GUEST_LIMITS[kind]
    since = _demo_started_at(user, db)
    if since is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Start the demo first"
        )

    if kind == "check":
        stmt = select(func.count()).select_from(AgentRequest).where(
            AgentRequest.requested_by == user.id, AgentRequest.created_at > since)
    elif kind == "study_guide":
        stmt = select(func.count()).select_from(StudyGuide).where(
            StudyGuide.requested_by == user.id, StudyGuide.created_at > since)
    elif kind == "quiz":
        stmt = select(func.count()).select_from(Quiz).where(
            Quiz.requested_by == user.id, Quiz.created_at > since)
    else:  # chat: questions only, never the assistant's answer rows
        stmt = select(func.count()).select_from(ChatMessage).where(
            ChatMessage.author_id == user.id,
            ChatMessage.role == "user",
            ChatMessage.created_at > since,
        )

    if db.scalar(stmt) >= limit:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Demo limit reached — {limit} of {limit} {label} used. Sign up to keep going.",
        )


def require_not_guest(user: User, action: str) -> None:
    """403 for things a demo sandbox does not offer."""
    if user.is_guest:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"The demo can't {action}. Sign up to use your own space.",
        )
