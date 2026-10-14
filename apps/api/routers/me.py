"""About the signed-in person. For now only what a demo guest has left."""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from auth import CurrentUser
from authz import guest_allowance
from database import get_db
from schemas import AllowanceOut

router = APIRouter(prefix="/me", tags=["me"])


@router.get("/allowance", response_model=AllowanceOut)
def allowance(user: CurrentUser, db: Session = Depends(get_db)):
    return AllowanceOut(is_guest=user.is_guest, limits=guest_allowance(user, db))
