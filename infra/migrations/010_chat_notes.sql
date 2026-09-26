-- "Make notes from these files", asked through the space chat.
--
-- A notes request is a chat answer of a different kind rather than a queue of
-- its own: it is asked in the thread, streams into the thread, and is read by
-- the same people, so it takes the same row, the same claim and the same poll.
-- What differs is the input, recorded here.
--
-- Idempotent, like 001-009. Against an existing local database apply it by
-- hand:  psql "$DATABASE_URL" -f infra/migrations/010_chat_notes.sql

-- 'answer' answers a question from retrieved excerpts. 'notes' reads the
-- named sources front to back and writes notes from them.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'answer';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chat_messages_kind_check'
    ) THEN
        ALTER TABLE chat_messages
            ADD CONSTRAINT chat_messages_kind_check CHECK (kind IN ('answer', 'notes'));
    END IF;
END $$;

-- The files a notes request reads, in the order they were given. An array
-- rather than a join table: it is written once, read once by the worker, and
-- never queried by source. A source deleted in the meantime is skipped.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS source_ids UUID[];

-- The open document's text when the request was made, so notes can add what
-- is missing instead of repeating what the group already wrote. Sent by the
-- client for the same reason study_guides.notes is: documents.crdt_snapshot
-- is a Yjs update and nothing in Python can decode one.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS context TEXT;
