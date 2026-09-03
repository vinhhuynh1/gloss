import uuid

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from models import Document, StudySpace, StudySpaceMember

router = APIRouter(prefix="/study-spaces", tags=["study-spaces"])


class CreateStudySpace(BaseModel):
    course_name: str
    created_by: uuid.UUID


@router.post("")
def create_study_space(body: CreateStudySpace, db: Session = Depends(get_db)):
    space = StudySpace(course_name=body.course_name, created_by=body.created_by)
    db.add(space)
    db.flush()

    # Creator is the first member, and gets a blank shared doc immediately.
    db.add(StudySpaceMember(study_space_id=space.id, user_id=body.created_by, role="owner"))
    db.add(Document(study_space_id=space.id))
    db.commit()
    db.refresh(space)
    return space


@router.get("/{study_space_id}")
def get_study_space(study_space_id: uuid.UUID, db: Session = Depends(get_db)):
    return db.get(StudySpace, study_space_id)


class InviteMember(BaseModel):
    user_id: uuid.UUID


@router.post("/{study_space_id}/members")
def invite_member(
    study_space_id: uuid.UUID, body: InviteMember, db: Session = Depends(get_db)
):
    member = StudySpaceMember(study_space_id=study_space_id, user_id=body.user_id)
    db.add(member)
    db.commit()
    return member
