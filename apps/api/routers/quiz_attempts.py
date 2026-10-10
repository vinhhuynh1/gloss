"""
Submitted quizzes and the weak spots computed from them.

Not part of routers/quizzes.py: that file is the generation queue, and this
is the first thing in the quiz feature written by a person rather than the
worker. See infra/migrations/015_quiz_attempts.sql.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import text
from sqlalchemy.orm import Session

from auth import CurrentUser
from authz import require_document, require_quiz
from database import get_db
from models import QuizAttempt
from schemas import AttemptOut, CreateAttempt, WeakSpotOut
from weak_spots import score_answers, tally

_table_present = False


def require_quiz_attempts_table(db: Session = Depends(get_db)) -> None:
    """Same guard as require_quizzes_table, for 015."""
    global _table_present
    if _table_present:
        return
    if not db.scalar(text("SELECT to_regclass('public.quiz_attempts') IS NOT NULL")):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "Saved quiz results aren't available yet: the quiz_attempts "
                "table is missing. Apply infra/migrations/015_quiz_attempts.sql, "
                "then re-run infra/supabase/011_lockdown.sql."
            ),
        )
    _table_present = True


router = APIRouter(
    tags=["quiz attempts"],
    dependencies=[Depends(require_quiz_attempts_table)],
)


@router.post(
    "/quizzes/{quiz_id}/attempts",
    response_model=AttemptOut,
    status_code=status.HTTP_201_CREATED,
)
def create_attempt(
    quiz_id: uuid.UUID,
    body: CreateAttempt,
    user: CurrentUser,
    db: Session = Depends(get_db),
):
    """Every submit is kept, retakes included. Any quiz the caller can see may
    be submitted, not only the newest: an attempt is tied to the questions it
    was answered against, which a groupmate's newer quiz does not change."""
    quiz = require_quiz(quiz_id, user, db)
    if quiz.status != "done" or not quiz.questions:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="This quiz isn't finished yet.",
        )
    questions = quiz.questions["questions"]
    if len(body.answers) != len(questions):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Expected {len(questions)} answers, got {len(body.answers)}.",
        )

    score = score_answers(questions, body.answers)
    db.add(QuizAttempt(quiz_id=quiz.id, user_id=user.id, answers=body.answers, score=score))
    db.commit()
    return AttemptOut(score=score, total=len(questions))


@router.get("/documents/{document_id}/weak-spots", response_model=list[WeakSpotOut])
def get_weak_spots(
    document_id: uuid.UUID, user: CurrentUser, db: Session = Depends(get_db)
):
    """The caller's own per-section totals for this document, weakest first.

    The latest attempt per quiz only, so retaking one quiz three times counts
    it once. Only `section` and `correct_index` are pulled out of the
    questions JSON; the cited excerpts stay in Postgres. Quizzes from before
    015 have no sections and are skipped.
    """
    require_document(document_id, user, db)
    rows = db.execute(
        text(
            """
            SELECT DISTINCT ON (a.quiz_id)
                   a.answers,
                   jsonb_path_query_array(q.questions, '$.questions[*].section'),
                   jsonb_path_query_array(q.questions, '$.questions[*].correct_index')
              FROM quiz_attempts a
              JOIN quizzes q ON q.id = a.quiz_id
             WHERE a.user_id = :user_id
               AND q.document_id = :document_id
               AND q.sections IS NOT NULL
             ORDER BY a.quiz_id, a.submitted_at DESC
            """
        ),
        {"user_id": user.id, "document_id": document_id},
    ).all()
    return tally(rows)
