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
from sqlalchemy.orm import Session

from models import Document, StudySpace, StudySpaceMember, User

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
