"""
Source material: upload, list, retry, delete.

This router accepts the file and stops there. It does not parse, chunk, or
embed — apps/agent-worker/worker.py does, picking the row up off the queue
this creates. That split is not ceremony: embedding pulls in
sentence-transformers and ~90MB of model weights, and loading that into a web
process would add seconds to every cold start and block a request thread for
the length of a PDF. The API stays a thin, fast, dependency-light service and
the heavy work happens where it can be scaled and restarted independently.

The cost of the split is that "upload succeeded" and "the agent can search
this" are now two different moments, which is why `status` exists on the row
and why the UI polls.
"""
import uuid

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from auth import CurrentUser
from authz import require_source, require_space
from database import get_db
from models import Source, SourceChunk
from schemas import SourceOut

router = APIRouter(tags=["sources"])

# 20MB. Every uploaded file is held in Postgres (see 003_source_ingestion.sql
# for why), so this is the one number keeping a lecture-slides deck from
# becoming a database problem. A 200-slide PDF is comfortably under it.
MAX_UPLOAD_BYTES = 20 * 1024 * 1024
_READ_BLOCK = 1024 * 1024

# Extension -> content type, and the whole allowlist in one place.
#
# Keyed on the extension rather than the browser-supplied content type on
# purpose: browsers report .md as text/markdown, text/plain, or
# application/octet-stream depending on the OS, so trusting that header would
# reject the same file on one machine and accept it on another.
ALLOWED_EXTENSIONS = {
    ".pdf": "application/pdf",
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".txt": "text/plain",
}


def _extension_of(filename: str) -> str:
    _, dot, ext = filename.rpartition(".")
    return f".{ext.lower()}" if dot else ""


def _read_capped(upload: UploadFile) -> bytes:
    """Read the upload, refusing anything over the cap.

    Read incrementally rather than upload.file.read(): the latter would
    materialize whatever the client chose to send before the size could be
    checked, which turns the cap into a suggestion.
    """
    buffer = bytearray()
    while True:
        block = upload.file.read(_READ_BLOCK)
        if not block:
            break
        buffer.extend(block)
        if len(buffer) > MAX_UPLOAD_BYTES:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=f"File is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)}MB",
            )
    return bytes(buffer)


def _chunk_counts(db: Session, source_ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    """One grouped count covering every source in the list.

    Deliberately not a count per row inside a loop — the sources panel polls
    this endpoint every couple of seconds while a file is processing, and N+1
    queries on a poll loop is how a smooth UI quietly becomes a hot database.
    """
    if not source_ids:
        return {}
    rows = db.execute(
        select(SourceChunk.source_id, func.count(SourceChunk.id))
        .where(SourceChunk.source_id.in_(source_ids))
        .group_by(SourceChunk.source_id)
    ).all()
    return {source_id: count for source_id, count in rows}


def _to_out(source: Source, chunk_count: int) -> SourceOut:
    return SourceOut(
        id=source.id,
        study_space_id=source.study_space_id,
        filename=source.filename,
        uploaded_by=source.uploaded_by,
        uploaded_at=source.uploaded_at,
        status=source.status,
        content_type=source.content_type,
        byte_size=source.byte_size,
        error=source.error,
        attempts=source.attempts,
        ingested_at=source.ingested_at,
        chunk_count=chunk_count,
    )


@router.get("/study-spaces/{study_space_id}/sources", response_model=list[SourceOut])
def list_sources(
    study_space_id: uuid.UUID, user: CurrentUser, db: Session = Depends(get_db)
):
    require_space(study_space_id, user, db)
    sources = db.scalars(
        select(Source)
        .where(Source.study_space_id == study_space_id)
        .order_by(Source.uploaded_at.desc())
    ).all()
    counts = _chunk_counts(db, [s.id for s in sources])
    return [_to_out(s, counts.get(s.id, 0)) for s in sources]


@router.post(
    "/study-spaces/{study_space_id}/sources",
    response_model=SourceOut,
    status_code=status.HTTP_202_ACCEPTED,
)
def upload_source(
    study_space_id: uuid.UUID,
    user: CurrentUser,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """
    202, not 201: the row exists, but the thing the caller actually wants —
    searchable chunks — does not yet. The response carries status "pending"
    and the client polls the list endpoint until it flips.

    Any member can upload, not just the owner. Study spaces are small invited
    groups, and "only the person who made the space may add the readings" is
    the wrong default for a study group.

    Defined with `def`, not `async def`, like every other handler here: the
    Session is synchronous, so an async handler would block the event loop on
    both the file read and the insert. FastAPI runs this in a threadpool.
    """
    require_space(study_space_id, user, db)

    filename = (file.filename or "").strip() or "upload"
    extension = _extension_of(filename)
    if extension not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=(
                "Unsupported file type. Upload a PDF, Markdown, or text file "
                + f"({', '.join(sorted(ALLOWED_EXTENSIONS))})."
            ),
        )

    data = _read_capped(file)
    if not data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="That file is empty"
        )

    source = Source(
        study_space_id=study_space_id,
        filename=filename,
        uploaded_by=user.id,
        status="pending",
        file_data=data,
        content_type=ALLOWED_EXTENSIONS[extension],
        byte_size=len(data),
    )
    db.add(source)
    db.commit()
    db.refresh(source)
    return _to_out(source, 0)


@router.post("/sources/{source_id}/retry", response_model=SourceOut)
def retry_source(
    source_id: uuid.UUID, user: CurrentUser, db: Session = Depends(get_db)
):
    """
    Put a source back on the queue — after a failure, or to re-chunk one that
    already succeeded.

    That second case is the one the build plan's eval loop needs: changing the
    chunk size or the embedding model invalidates every existing chunk, and
    re-running the corpus is how you find out whether the change helped. The
    worker clears a source's old chunks before writing new ones, so this is
    safe to press on a "ready" source.

    attempts resets to zero: the worker gives up after MAX_ATTEMPTS so a file
    that crashes the parser cannot spin forever, and without this reset that
    ceiling would also block a legitimate retry after someone fixed the cause.
    """
    source = require_source(source_id, user, db)
    if source.status not in ("failed", "ready"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Source is already {source.status}",
        )
    # Asked of the database rather than read off the object: file_data is
    # deferred (see models.py), so touching the attribute would fetch the whole
    # PDF just to compare it against None. This returns a boolean.
    has_bytes = db.scalar(
        select(Source.file_data.is_not(None)).where(Source.id == source_id)
    )
    if not has_bytes:
        # Rows written by the ingest.py CLI never carried their bytes here.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This source was ingested from the command line; re-run ingest.py",
        )

    source.status = "pending"
    source.error = None
    source.attempts = 0
    source.claimed_at = None
    db.commit()
    db.refresh(source)
    return _to_out(source, len(source.chunks))


@router.delete("/sources/{source_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_source(
    source_id: uuid.UUID, user: CurrentUser, db: Session = Depends(get_db)
):
    """Removing a source removes its chunks with it, via ON DELETE CASCADE —
    leaving them behind would keep the material retrievable, and citable, after
    the group decided it did not belong to the course."""
    source = require_source(source_id, user, db)
    db.delete(source)
    db.commit()
