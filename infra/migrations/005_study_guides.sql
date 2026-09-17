-- Generated study guides, triggered from the editor.
--
-- The third thing the worker does, and a queue for the same reason the other
-- two are: generating a guide needs retrieval, retrieval needs the embedding
-- model, and that lives only in apps/agent-worker. So the API writes a row
-- here and the worker picks it up, exactly as 003 did for uploads and 004 for
-- checks.
--
-- Idempotent, like 001-004. Against an existing local database apply it by
-- hand:  psql "$DATABASE_URL" -f infra/migrations/005_study_guides.sql
--
-- Remember to re-run infra/supabase/011_lockdown.sql after this: a new table
-- is readable through PostgREST with the public anon key until it is.

-- 'pending' -> 'processing' -> 'done' | 'failed'
--
-- Unlike agent_requests there is no 'found nothing' outcome. A guide is
-- generated from notes the group already wrote, so the only reasons to end
-- without one are an empty document or a failure, and both are errors worth
-- showing.
CREATE TABLE IF NOT EXISTS study_guides (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    requested_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- The document's text, as the browser read it when the guide was asked
    -- for. Sent by the client for the same reason agent_requests.passage is:
    -- documents.crdt_snapshot is a Yjs update, and nothing in Python can
    -- decode one. The worker never reads that column.
    notes TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    claimed_at TIMESTAMPTZ,
    error TEXT,
    -- The generated guide: {title, sections:[{heading, points:[...]}],
    -- key_terms:[...]}. Every point and term carries the chunk it was drawn
    -- from, together with that chunk's filename, page_ref and excerpt copied
    -- in at write time — same reasoning as the snapshot columns 004 added to
    -- suggestions. Chunk ids do not survive re-chunking, and a guide whose
    -- citations decay into "unknown source" is worth less than no guide.
    guide JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ
);

-- The worker's queue poll and stale-claim sweep, partial for the same reason
-- as sources_pending_idx and agent_requests_pending_idx: in steady state
-- almost every row is finished.
CREATE INDEX IF NOT EXISTS study_guides_pending_idx
    ON study_guides (created_at)
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS study_guides_processing_idx
    ON study_guides (claimed_at)
    WHERE status = 'processing';

-- Backs GET /documents/{id}/study-guide, which asks for the newest row and is
-- polled while one is running.
CREATE INDEX IF NOT EXISTS study_guides_document_created_idx
    ON study_guides (document_id, created_at DESC);
