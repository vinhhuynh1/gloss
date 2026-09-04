import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from auth import CurrentUser
from authz import OWNER_ONLY, require_space
from database import get_db
from models import Document, StudySpace, StudySpaceMember, User
from schemas import (
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


@router.get("/{study_space_id}/document", response_model=DocumentOut)
def get_space_document(
    study_space_id: uuid.UUID, user: CurrentUser, db: Session = Depends(get_db)
):
    """
    The space's shared notes document.

    This is how the frontend learns a real document uuid — it is the entry
    point for both the editor's Yjs room name and the suggestion sidebar.
    """
    require_space(study_space_id, user, db)
    doc = db.scalars(
        select(Document)
        .where(Document.study_space_id == study_space_id)
        .order_by(Document.updated_at)
        .limit(1)
    ).first()
    if doc is None:
        # A space created before this endpoint existed, or a partial create.
        doc = Document(study_space_id=study_space_id)
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
