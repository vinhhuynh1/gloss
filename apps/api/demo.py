"""
Demo mode: copying the template study space into a guest's sandbox.

Plain functions, kept out of the router so the copy is testable without HTTP
and lives in one place. Nothing here commits — the router owns the
transaction, so a copy that fails partway leaves nothing behind.

The copy is SQL INSERT ... SELECT rather than ORM objects: source_chunks
carries a 384-float embedding per row and documents carry the whole Yjs
history, and neither needs a round trip through Python to be copied.

Suggestion anchors are serialized Yjs relative positions. Copying
crdt_snapshot byte for byte keeps the same Yjs item ids, so a copied anchor
still points at the same text in the copy.

See docs/superpowers/specs/2026-10-13-demo-mode-design.md.
"""
import os
import uuid

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from models import StudySpace, StudySpaceMember, User

DEMO_SUFFIX = " (demo)"
DEFAULT_DAILY_LIMIT = 50


class DemoUnavailable(Exception):
    """The template is not configured or no longer exists."""


def template_space_id() -> uuid.UUID | None:
    raw = os.getenv("DEMO_TEMPLATE_SPACE_ID", "").strip()
    if not raw:
        return None
    try:
        return uuid.UUID(raw)
    except ValueError:
        return None


def daily_limit() -> int:
    try:
        return int(os.getenv("DEMO_DAILY_LIMIT", str(DEFAULT_DAILY_LIMIT)))
    except ValueError:
        return DEFAULT_DAILY_LIMIT


def existing_demo_space(db: Session, user: User) -> StudySpace | None:
    return db.scalars(
        select(StudySpace)
        .join(StudySpaceMember, StudySpaceMember.study_space_id == StudySpace.id)
        .where(StudySpaceMember.user_id == user.id, StudySpace.is_demo)
        .order_by(StudySpace.created_at)
    ).first()


def demos_created_today(db: Session) -> int:
    return db.scalar(
        select(func.count())
        .select_from(StudySpace)
        .where(StudySpace.is_demo, StudySpace.created_at >= func.date_trunc("day", func.now()))
    )


def copy_template(db: Session, template_id: uuid.UUID, guest: User) -> StudySpace:
    template = db.get(StudySpace, template_id)
    if template is None:
        raise DemoUnavailable(f"template space {template_id} does not exist")

    # created_at from the database clock: the guest quota counts rows created
    # after this moment, and every copied row keeps the template's older
    # created_at, so the copied guide and quiz never use up the allowance.
    space = StudySpace(
        course_name=template.course_name + DEMO_SUFFIX,
        created_by=guest.id,
        is_demo=True,
        created_at=func.now(),
    )
    db.add(space)
    db.flush()
    db.add(StudySpaceMember(study_space_id=space.id, user_id=guest.id, role="owner"))
    db.flush()

    base = {"new_space": space.id, "old_space": template.id, "guest": guest.id}

    doc_ids = db.scalars(
        text("SELECT id FROM documents WHERE study_space_id = :old_space ORDER BY created_at"),
        base,
    ).all()
    for old_doc in doc_ids:
        p = {**base, "old": old_doc, "new": uuid.uuid4()}
        db.execute(text("""
            INSERT INTO documents (id, study_space_id, crdt_snapshot, title, created_at, updated_at)
            SELECT :new, :new_space, crdt_snapshot, title, created_at, now()
              FROM documents WHERE id = :old
        """), p)
        # Open suggestions only. source_chunk_id is dropped: it points at the
        # template's chunk, and the citation text is already denormalized
        # onto the suggestion.
        db.execute(text("""
            INSERT INTO suggestions (id, document_id, type, anchor, proposed_text,
                                     source_chunk_id, source_filename, source_page_ref,
                                     source_excerpt, status, created_at)
            SELECT gen_random_uuid(), :new, type, anchor, proposed_text,
                   NULL, source_filename, source_page_ref, source_excerpt, 'pending', created_at
              FROM suggestions WHERE document_id = :old AND status = 'pending'
        """), p)
        db.execute(text("""
            INSERT INTO study_guides (id, document_id, requested_by, notes, status,
                                      attempts, guide, created_at, finished_at)
            SELECT gen_random_uuid(), :new, :guest, notes, 'done',
                   attempts, guide, created_at, finished_at
              FROM study_guides WHERE document_id = :old AND status = 'done'
             ORDER BY created_at DESC LIMIT 1
        """), p)
        # The group quiz only — a practice quiz belongs to one person.
        db.execute(text("""
            INSERT INTO quizzes (id, document_id, requested_by, notes, status, attempts,
                                 questions, sections, created_at, finished_at)
            SELECT gen_random_uuid(), :new, :guest, notes, 'done', attempts,
                   questions, sections, created_at, finished_at
              FROM quizzes
             WHERE document_id = :old AND status = 'done' AND personal_for IS NULL
             ORDER BY created_at DESC LIMIT 1
        """), p)

    # Ready sources only, so the sandbox never shows a stuck "Processing" row.
    # file_data is copied: chat's notes mode re-reads the original file
    # (worker.py _load_note_files).
    source_ids = db.scalars(
        text("SELECT id FROM sources WHERE study_space_id = :old_space AND status = 'ready'"),
        base,
    ).all()
    for old_source in source_ids:
        p = {**base, "old": old_source, "new": uuid.uuid4()}
        db.execute(text("""
            INSERT INTO sources (id, study_space_id, filename, uploaded_by, uploaded_at, status,
                                 file_data, content_type, byte_size, attempts, ingested_at)
            SELECT :new, :new_space, filename, :guest, uploaded_at, 'ready',
                   file_data, content_type, byte_size, attempts, ingested_at
              FROM sources WHERE id = :old
        """), p)
        db.execute(text("""
            INSERT INTO source_chunks (id, source_id, text, embedding, page_ref)
            SELECT gen_random_uuid(), :new, text, embedding, page_ref
              FROM source_chunks WHERE source_id = :old
        """), p)

    db.flush()
    return space
