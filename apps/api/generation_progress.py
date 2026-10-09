"""
Progress on a running study guide or quiz, for the status polls.

The columns come from infra/migrations/012_generation_progress.sql, and the
API deploys on a merge while migrations are applied by hand — the gap that
already cost the chat an afternoon once. So they are read here, by a query of
their own, only once they are known to exist; until then the polls answer
exactly as they did before, without progress. The ORM models declare the
columns deferred and without defaults for the same reason: an ordinary read or
insert of a guide never names them, so it cannot fail on their absence.
"""
import uuid

from sqlalchemy import text
from sqlalchemy.orm import Session

_TABLES = ("study_guides", "quizzes")

# Flipped once the columns have been seen, and never checked again — the same
# device as the table guards in routers/study_guides.py.
_present: set[str] = set()


def _columns_present(db: Session, table: str) -> bool:
    if table in _present:
        return True
    found = db.scalar(
        text(
            """
            SELECT count(*) FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = :table
               AND column_name IN ('progress', 'stage')
            """
        ),
        {"table": table},
    )
    if found == 2:
        _present.add(table)
        return True
    return False


def progress_for(db: Session, table: str, row_id: uuid.UUID) -> dict:
    """{"progress": int, "stage": str | None}, or {} when the columns are not
    there yet."""
    assert table in _TABLES  # interpolated below; never user input
    if not _columns_present(db, table):
        return {}
    row = db.execute(
        text(f"SELECT progress, stage FROM {table} WHERE id = :id"), {"id": row_id}
    ).first()
    return {"progress": row[0], "stage": row[1]} if row else {}
