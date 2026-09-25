import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from auth import CurrentUser
from authz import OWNER_ONLY, require_space
from database import get_db
from models import Document, StudySpace, StudySpaceMember, User
from schemas import (
    CreateDocument,
    CreateStudySpace,
    DocumentOut,
    InviteMember,
    MemberOut,
    StudySpaceOut,
    UpdateStudySpace,
)

router = APIRouter(prefix="/study-spaces", tags=["study-spaces"])


@router.get("", response_model=list[StudySpaceOut])
def list_study_spaces(user: CurrentUser, db: Session = Depends(get_db)):
    """Every space the caller belongs to. Without this the frontend has no
    way to discover a space it wasn't handed the uuid for."""
    return db.scalars(
        select(StudySpace)
        .join(StudySpaceMember, StudySpaceMember.study_space_id == StudySpace.id)
        .where(StudySpaceMember.user_id == user.id)
        .order_by(StudySpace.created_at.desc())
    ).all()


@router.post("", response_model=StudySpaceOut, status_code=status.HTTP_201_CREATED)
def create_study_space(
    body: CreateStudySpace, user: CurrentUser, db: Session = Depends(get_db)
):
    # The owner comes from the verified token, never from the request body.
    space = StudySpace(course_name=body.course_name, created_by=user.id)
    db.add(space)
    db.flush()

    # Creator is the first member, and gets a blank shared doc immediately.
    db.add(StudySpaceMember(study_space_id=space.id, user_id=user.id, role="owner"))
    db.add(Document(study_space_id=space.id))
    db.commit()
    db.refresh(space)
    return space


@router.get("/{study_space_id}", response_model=StudySpaceOut)
def get_study_space(
    study_space_id: uuid.UUID, user: CurrentUser, db: Session = Depends(get_db)
):
    return require_space(study_space_id, user, db)


@router.patch("/{study_space_id}", response_model=StudySpaceOut)
def update_study_space(
    study_space_id: uuid.UUID,
    body: UpdateStudySpace,
    user: CurrentUser,
    db: Session = Depends(get_db),
):
    space = require_space(study_space_id, user, db, roles=OWNER_ONLY)
    space.course_name = body.course_name
    db.commit()
    db.refresh(space)
    return space


@router.delete("/{study_space_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_study_space(
    study_space_id: uuid.UUID, user: CurrentUser, db: Session = Depends(get_db)
):
    space = require_space(study_space_id, user, db, roles=OWNER_ONLY)
    # Children go via Postgres ON DELETE CASCADE — see the passive_deletes
    # note on StudySpace.documents in models.py.
    db.delete(space)
    db.commit()


def _first_document(db: Session, study_space_id: uuid.UUID) -> Document:
    """The space's oldest document, created on demand if it has none.

    Create-on-demand is what makes a freshly made space openable without a
    second round trip, and it also covers spaces made before documents
    existed. Ordered by created_at rather than updated_at so "the first
    document" does not change identity the moment somebody types in another
    one — see the column comment in 008.
    """
    doc = db.scalars(
        select(Document)
        .where(Document.study_space_id == study_space_id)
        .order_by(Document.created_at)
        .limit(1)
    ).first()
    if doc is None:
        doc = Document(study_space_id=study_space_id, title="Notes")
        db.add(doc)
        db.commit()
        db.refresh(doc)
    return doc


@router.get("/{study_space_id}/document", response_model=DocumentOut)
def get_space_document(
    study_space_id: uuid.UUID, user: CurrentUser, db: Session = Depends(get_db)
):
    """
    The space's first notes document.

    Superseded by GET /{id}/documents, and kept because a client that has not
    been redeployed still calls it — the web app is on Vercel and the API on
    Railway, so the two are never updated in the same instant. It now means
    "the first document" rather than "the document".
    """
    require_space(study_space_id, user, db)
    return _first_document(db, study_space_id)


@router.get("/{study_space_id}/documents", response_model=list[DocumentOut])
def list_space_documents(
    study_space_id: uuid.UUID, user: CurrentUser, db: Session = Depends(get_db)
):
    """Every document in the space, oldest first.

    Never empty: a space with no documents gets one here rather than handing
    the editor an empty list it would have to special-case.
    """
    require_space(study_space_id, user, db)
    docs = db.scalars(
        select(Document)
        .where(Document.study_space_id == study_space_id)
        .order_by(Document.created_at)
    ).all()
    return list(docs) or [_first_document(db, study_space_id)]


@router.post(
    "/{study_space_id}/documents",
    response_model=DocumentOut,
    status_code=status.HTTP_201_CREATED,
)
def create_space_document(
    study_space_id: uuid.UUID,
    body: CreateDocument,
    user: CurrentUser,
    db: Session = Depends(get_db),
):
    """Add a document. Any member may — a course's notes are the group's, and
    requiring the owner to make every week's page would make them a
    bottleneck on the one action everyone needs."""
    require_space(study_space_id, user, db)
    doc = Document(study_space_id=study_space_id, title=body.title)
    db.add(doc)
    db.commit()
    db.refresh(doc)
    return doc


@router.get("/{study_space_id}/members", response_model=list[MemberOut])
def list_members(
    study_space_id: uuid.UUID, user: CurrentUser, db: Session = Depends(get_db)
):
    require_space(study_space_id, user, db)
    rows = db.execute(
        select(StudySpaceMember, User)
        .join(User, User.id == StudySpaceMember.user_id)
        .where(StudySpaceMember.study_space_id == study_space_id)
        .order_by(StudySpaceMember.joined_at)
    ).all()
    return [
        MemberOut(
            user_id=m.user_id,
            email=u.email,
            name=u.name,
            role=m.role,
            joined_at=m.joined_at,
        )
        for m, u in rows
    ]


@router.post("/{study_space_id}/members", response_model=MemberOut)
def invite_member(
    study_space_id: uuid.UUID,
    body: InviteMember,
    user: CurrentUser,
    db: Session = Depends(get_db),
):
    require_space(study_space_id, user, db, roles=OWNER_ONLY)

    invitee = db.scalars(select(User).where(User.email == body.email)).first()
    if invitee is None:
        # No pending-invite table yet — you can only invite someone who has
        # already signed up. Inviting a stranger by email is a week-6 feature.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No account with that email. Ask them to sign up first.",
        )

    existing = db.get(StudySpaceMember, (study_space_id, invitee.id))
    if existing is None:
        existing = StudySpaceMember(
            study_space_id=study_space_id, user_id=invitee.id, role="member"
        )
        db.add(existing)
        db.commit()
        db.refresh(existing)

    # Re-inviting is a no-op rather than a 500 on the composite primary key.
    return MemberOut(
        user_id=invitee.id,
        email=invitee.email,
        name=invitee.name,
        role=existing.role,
        joined_at=existing.joined_at,
    )
