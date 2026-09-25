-- Generated flashcard decks, triggered from the editor.
--
-- The fourth queue, and the fourth instance of the same arrangement: writing
-- cards needs retrieval, retrieval needs the embedding model, and that lives
-- only in apps/agent-worker. The API writes a row here and the worker picks
-- it up, exactly as 003 did for uploads, 004 for checks and 005 for guides.
--
-- Deliberately a separate table from study_guides rather than a `kind` column
-- on it. The two share a lifecycle but not a payload: a guide is sections of
-- prose and a deck is a list of question/answer pairs, and one JSONB column
-- holding either shape means every reader has to branch on which it got. The
-- duplicated status machinery is the cheaper half of that trade.
--
-- Idempotent, like 001-006. Against an existing local database apply it by
-- hand:  psql "$DATABASE_URL" -f infra/migrations/007_flashcards.sql
--
-- Remember to re-run infra/supabase/011_lockdown.sql after this: a new table
-- is readable through PostgREST with the public anon key until it is.

-- 'pending' -> 'processing' -> 'done' | 'failed'
--
-- Same two end states as study_guides and for the same reason: a deck is
-- generated from notes the group already wrote, so the only ways to finish
-- without one are an empty document or a failure, and both are worth showing.
CREATE TABLE IF NOT EXISTS flashcard_sets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    requested_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- The document's text, as the browser read it. Sent by the client for the
    -- same reason study_guides.notes is: documents.crdt_snapshot is a Yjs
    -- update and nothing in Python can decode one.
    notes TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    claimed_at TIMESTAMPTZ,
    error TEXT,
    -- The generated deck: {title, cards:[{front, back, source_chunk_id, ...}]}.
    -- Every card carries the chunk it was drawn from together with that
    -- chunk's filename, page_ref and excerpt, copied in at write time — the
    -- same contract as study_guides.guide and the suggestion snapshot columns
    -- in 004. A card whose citation has decayed into "unknown source" is a
    -- card a student cannot check, which is the one thing this app promises
    -- they can always do.
    cards JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ
);

-- The worker's queue poll and stale-claim sweep, partial for the same reason
-- as sources_pending_idx: in steady state almost every row is finished.
CREATE INDEX IF NOT EXISTS flashcard_sets_pending_idx
    ON flashcard_sets (created_at)
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS flashcard_sets_processing_idx
    ON flashcard_sets (claimed_at)
    WHERE status = 'processing';

-- Backs GET /documents/{id}/flashcards, which asks for the newest row and is
-- polled while one is running.
CREATE INDEX IF NOT EXISTS flashcard_sets_document_created_idx
    ON flashcard_sets (document_id, created_at DESC);
