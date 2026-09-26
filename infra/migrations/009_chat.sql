-- The space chat: one shared thread per study space, where anyone in the
-- space can ask about the course material and everyone sees the answers.
--
-- The fifth queue, on the same arrangement as 003-007: answering needs
-- retrieval, retrieval needs the embedding model, and that lives only in
-- apps/agent-worker. The API writes the question and a 'pending' answer row in
-- one transaction, and the worker claims the answer row.
--
-- One table for both sides of the conversation rather than questions and
-- answers apart. The thread is read as one ordered list, polled, and paged
-- backwards; two tables would make every one of those a UNION.
--
-- Idempotent, like 001-008. Against an existing local database apply it by
-- hand:  psql "$DATABASE_URL" -f infra/migrations/009_chat.sql
--
-- Remember to re-run infra/supabase/011_lockdown.sql after this: a new table
-- is readable through PostgREST with the public anon key until it is.

-- status: a question is 'done' the moment it is written. An answer goes
-- 'pending' -> 'processing' -> 'done' | 'failed', and while 'processing' its
-- body grows as the worker streams the reply in.
CREATE TABLE IF NOT EXISTS chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    study_space_id UUID NOT NULL REFERENCES study_spaces(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    -- Null on every answer. SET NULL rather than CASCADE on a question: the
    -- thread is shared, and someone leaving should not punch holes in a
    -- conversation the rest of the group is still reading.
    author_id UUID REFERENCES users(id) ON DELETE SET NULL,
    -- The question an answer answers. Null on questions.
    reply_to UUID REFERENCES chat_messages(id) ON DELETE CASCADE,
    body TEXT NOT NULL DEFAULT '',
    -- Answers only: [{n, chunk_id, filename, page_ref, excerpt}], where n is
    -- the [n] marker in the body. Snapshotted at write time for the same
    -- reason as study_guides.guide — a citation must still say where it came
    -- from after the source is re-chunked or removed.
    citations JSONB,
    status TEXT NOT NULL DEFAULT 'done',
    attempts INTEGER NOT NULL DEFAULT 0,
    claimed_at TIMESTAMPTZ,
    error TEXT,
    -- clock_timestamp(), not now(): the question and its answer row are
    -- inserted in one transaction, and now() would give them the same
    -- created_at and no order between them.
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    -- Bumped on every write, including each streamed chunk of an answer.
    -- The client polls for rows changed since the last one it saw, so this is
    -- what makes a poll return only what moved.
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    finished_at TIMESTAMPTZ,
    CHECK (role = 'assistant' OR reply_to IS NULL)
);

-- The worker's queue poll and stale-claim sweep, partial for the same reason
-- as sources_pending_idx: in steady state almost every row is finished.
CREATE INDEX IF NOT EXISTS chat_messages_pending_idx
    ON chat_messages (created_at)
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS chat_messages_processing_idx
    ON chat_messages (claimed_at)
    WHERE status = 'processing';

-- Backs the first load and "show earlier", which page by created_at.
CREATE INDEX IF NOT EXISTS chat_messages_space_created_idx
    ON chat_messages (study_space_id, created_at DESC);

-- Backs the poll, which asks for rows changed since a cursor.
CREATE INDEX IF NOT EXISTS chat_messages_space_updated_idx
    ON chat_messages (study_space_id, updated_at);
