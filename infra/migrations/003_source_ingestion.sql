-- Upload-driven ingestion.
--
-- Before this, `sources` rows only ever came from `python ingest.py` on a
-- developer's laptop: the file was already on disk, and by the time the row
-- existed its chunks existed too. Uploading through the API splits those two
-- moments apart — the row is created by a web request, the chunks are written
-- seconds to minutes later by apps/agent-worker — so the table has to carry
-- the state in between.
--
-- Idempotent, like 001 and 002. Note that docker-compose only runs these on
-- first boot of an empty volume; against an existing local database apply it
-- by hand:  psql "$DATABASE_URL" -f infra/migrations/003_source_ingestion.sql

-- 'pending' -> 'processing' -> 'ready' | 'failed'
--
-- DEFAULT 'ready' is for the rows that already exist: everything ingest.py or
-- seed_demo.py wrote is, by construction, already chunked and embedded. The
-- API overrides it with 'pending' on upload.
ALTER TABLE sources ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ready';

-- The bytes as uploaded, kept rather than discarded after a successful pass.
--
-- Two reasons. The worker runs in a different process (and, deployed, on a
-- different machine) from the API that accepted the upload, so the file has
-- to travel through storage they share, and Postgres is the only such store
-- this project has. And re-chunking is a routine act here, not an exception:
-- the eval loop in the build plan explicitly calls for re-running the corpus
-- after a chunking or embedding change, which is impossible once the original
-- file is gone. Capped by MAX_UPLOAD_BYTES in apps/api/routers/sources.py;
-- swap for object storage if the corpus ever outgrows that.
ALTER TABLE sources ADD COLUMN IF NOT EXISTS file_data BYTEA;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS content_type TEXT;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS byte_size INTEGER;

-- Why a pass failed, shown verbatim in the UI. A scanned PDF with no text
-- layer is the common case and is indistinguishable from success unless the
-- reason gets back to the person who uploaded it.
ALTER TABLE sources ADD COLUMN IF NOT EXISTS error TEXT;

-- Claim bookkeeping for the queue in apps/agent-worker/worker.py.
-- claimed_at makes a crashed worker recoverable: a row stuck in 'processing'
-- past the stale timeout goes back to 'pending' instead of sitting there
-- forever. attempts stops a file that crashes the parser from being retried
-- in a loop until someone notices.
ALTER TABLE sources ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS ingested_at TIMESTAMPTZ;

-- Partial, not a plain index on status: the queue poll only ever asks for
-- work that is waiting, and in steady state almost every row is 'ready'.
-- This keeps the index roughly the size of the backlog.
CREATE INDEX IF NOT EXISTS sources_pending_idx
    ON sources (uploaded_at)
    WHERE status = 'pending';

-- Backs the stale-claim sweep, which asks the same question about
-- 'processing'.
CREATE INDEX IF NOT EXISTS sources_processing_idx
    ON sources (claimed_at)
    WHERE status = 'processing';
