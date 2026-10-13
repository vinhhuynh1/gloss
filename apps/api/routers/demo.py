"""
POST /demo — start (or resume) the caller's demo sandbox.

Only guests (Supabase anonymous identities, users.is_guest) may call it; a
signed-in normal user gets 403 rather than a copy they would then own. See
docs/superpowers/specs/2026-10-13-demo-mode-design.md.
"""
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import text
from sqlalchemy.orm import Session

import demo
from auth import CurrentUser
from database import get_db
from schemas import StudySpaceOut

router = APIRouter(prefix="/demo", tags=["demo"])

BUSY = "The demo is busy right now — try again tomorrow."


def _busy() -> HTTPException:
    return HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=BUSY)


@router.post("", response_model=StudySpaceOut)
def start_demo(user: CurrentUser, db: Session = Depends(get_db)):
    if not user.is_guest:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only demo sessions can start a demo",
        )

    # Serialize per guest: a double-click or two tabs must not make two
    # sandboxes. The lock is released when this transaction ends.
    db.execute(text("SELECT pg_advisory_xact_lock(hashtext(:k))"), {"k": f"demo:{user.id}"})

    existing = demo.existing_demo_space(db, user)
    if existing is not None:
        db.commit()
        return existing

    template_id = demo.template_space_id()
    if template_id is None or demo.demos_created_today(db) >= demo.daily_limit():
        db.rollback()
        raise _busy()

    try:
        space = demo.copy_template(db, template_id, user)
        db.commit()
    except demo.DemoUnavailable as exc:
        db.rollback()
        raise _busy() from exc
    except Exception:
        db.rollback()
        raise

    db.refresh(space)
    return space
