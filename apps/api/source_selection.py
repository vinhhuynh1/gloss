"""Which sources a request may name. Shared by chat's notes requests and the
study guide and quiz endpoints, so "a file in this space" means the same
thing everywhere."""
import uuid

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from models import Source


def validate_source_ids(
    db: Session, space_id: uuid.UUID, ids: list[uuid.UUID], *, empty_detail: str
) -> list[uuid.UUID]:
    """De-duplicated in the order given; 422 when empty; 404 when any id is
    not a source in this space."""
    unique = list(dict.fromkeys(ids))
    if not unique:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=empty_detail)
    found = set(
        db.scalars(
            select(Source.id).where(Source.id.in_(unique), Source.study_space_id == space_id)
        ).all()
    )
    if len(found) != len(unique):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="One of those files is not in this space any more.",
        )
    return unique
