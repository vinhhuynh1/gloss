-- On-demand agent passes, triggered from the editor.
--
-- The agent can only run where retrieval runs, and retrieval needs the
-- embedding model, which lives in apps/agent-worker and nowhere else — the API
-- container deliberately does not carry torch. So a "check this passage"
-- request is written here by the API and picked up by the worker, the same
-- table-as-queue arrangement 003 set up for uploads, for the same reasons.
--
-- Idempotent, like 001-003. Against an existing local database apply it by
-- hand:  psql "$DATABASE_URL" -f infra/migrations/004_agent_requests.sql

-- 'pending' -> 'processing' -> 'done' | 'failed'
--
-- 'done' covers both outcomes of a successful pass: a suggestion was written
-- (result_type names its type, suggestion_id points at it), or the agent
-- found nothing worth flagging (result_type = 'none'). The second is a real
-- answer, not a failure, and the person who asked needs to be told it.
CREATE TABLE IF NOT EXISTS agent_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    requested_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- The selected text, as it read when the request was made.
    passage TEXT NOT NULL,
    -- Serialized Yjs relative positions {from, to, quote}, computed by the
    -- browser. Opaque to everything but the frontend; the worker copies it
    -- onto the suggestion unchanged.
    anchor JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    claimed_at TIMESTAMPTZ,
    error TEXT,
    result_type TEXT, -- 'none' | 'citation' | 'contradiction' | 'gap_fill'
    -- The model's one-line justification. For debugging and the eval log,
    -- never shown in the UI.
    reasoning TEXT,
    suggestion_id UUID REFERENCES suggestions(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ
);

-- The worker's queue poll and stale-claim sweep, partial for the same reason
-- as sources_pending_idx: in steady state almost every row is finished.
CREATE INDEX IF NOT EXISTS agent_requests_pending_idx
    ON agent_requests (created_at)
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS agent_requests_processing_idx
    ON agent_requests (claimed_at)
    WHERE status = 'processing';

-- Backs GET /documents/{id}/agent-requests, which the editor polls.
CREATE INDEX IF NOT EXISTS agent_requests_document_requester_idx
    ON agent_requests (document_id, requested_by, created_at);

-- A suggestion must not pin the chunk it cites.
--
-- As declared in 001, this foreign key had no ON DELETE rule, so the first
-- suggestion citing a chunk made that chunk undeletable. Re-ingesting a
-- source (worker.py clears its chunks before writing new ones), the retry
-- endpoint, and deleting a source outright would all then fail with a
-- foreign-key violation. SET NULL lets the chunk go; the snapshot columns
-- below keep what the suggestion needs to still say where it came from.
--
-- Drop-then-add in one transaction, so a failure between the two cannot
-- leave the column without its constraint.
BEGIN;
ALTER TABLE suggestions DROP CONSTRAINT IF EXISTS suggestions_source_chunk_id_fkey;
ALTER TABLE suggestions
    ADD CONSTRAINT suggestions_source_chunk_id_fkey
    FOREIGN KEY (source_chunk_id) REFERENCES source_chunks(id) ON DELETE SET NULL;
COMMIT;

-- Where the cited passage came from, copied at the moment the suggestion is
-- written. Chunk ids do not survive re-chunking, and a citation that turns
-- into "unknown source" the next time someone tunes CHUNK_SIZE_CHARS is not a
-- citation.
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS source_filename TEXT;
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS source_page_ref TEXT;
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS source_excerpt TEXT;
