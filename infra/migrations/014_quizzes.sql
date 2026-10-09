-- Multiple-choice quizzes, replacing flashcard decks.
--
-- Same queue-as-table as study_guides and the flashcard_sets it replaces:
-- 'pending' -> 'processing' -> 'done' | 'failed'. The API only ever writes
-- 'pending'; apps/agent-worker/worker.py owns every other transition, because
-- writing a quiz needs retrieval and retrieval needs the embedding model.
--
-- The progress and stage columns are part of the table from the start rather
-- than added later like 012 did for the other two: there is no older copy of
-- this table to stay compatible with.
--
-- flashcard_sets is dropped at the end. A deck cannot be turned into a quiz -
-- a card has an answer but no wrong options - so there is nothing to carry
-- over, and leaving the table would leave a second, dead copy of a feature.
--
-- Idempotent, like 001-013. Against an existing local database apply it by
-- hand:  psql "$DATABASE_URL" -f infra/migrations/014_quizzes.sql
-- then re-run infra/supabase/011_lockdown.sql on Supabase.

CREATE TABLE IF NOT EXISTS quizzes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    requested_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- The document's text as the browser read it, for the same reason as
    -- study_guides.notes: documents.crdt_snapshot is a Yjs update and nothing
    -- in Python can decode one.
    notes TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    claimed_at TIMESTAMPTZ,
    error TEXT,
    -- {title, questions:[{question, options[4], correct_index, explanation,
    -- source_chunk_id, source_filename, source_page_ref, source_excerpt}]}.
    -- The source fields are copied in at write time so a question can still
    -- be checked against the course material after the next re-chunk.
    questions JSONB,
    progress SMALLINT NOT NULL DEFAULT 0,
    stage TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ
);

-- The worker's queue poll and stale-claim sweep. Partial: in steady state
-- almost every row is finished.
CREATE INDEX IF NOT EXISTS quizzes_pending_idx
    ON quizzes (created_at)
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS quizzes_processing_idx
    ON quizzes (claimed_at)
    WHERE status = 'processing';

-- Backs GET /documents/{id}/quiz, which asks for the newest row and is polled
-- while one is running.
CREATE INDEX IF NOT EXISTS quizzes_document_created_idx
    ON quizzes (document_id, created_at DESC);

-- Same lockdown every other table gets in infra/supabase/011_lockdown.sql:
-- the browser never talks to Postgres directly, so RLS on with no policies
-- means the anon key reads nothing.
ALTER TABLE quizzes ENABLE ROW LEVEL SECURITY;

DROP TABLE IF EXISTS flashcard_sets;
