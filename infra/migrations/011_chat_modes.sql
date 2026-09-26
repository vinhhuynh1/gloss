-- Plan and auto modes for "Make notes".
--
-- Auto writes the notes and puts them straight into the document. Plan first
-- posts an outline — the sections the notes will have — that the asker can
-- trim, reorder and rename before any notes are written; approving it writes
-- the notes and puts them into the document the same way.
--
-- In both, the notes still reach the document through the asker's browser
-- with an ordinary editor command (apps/web/src/lib/notesToDoc.ts). The worker
-- never writes into a document. "Auto" removes the click, not that rule.
--
-- Idempotent, like 001-010. Against an existing local database apply it by
-- hand:  psql "$DATABASE_URL" -f infra/migrations/011_chat_modes.sql

-- 'plan' joins 'answer' and 'notes': an outline for notes not yet written.
ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_kind_check;
ALTER TABLE chat_messages
    ADD CONSTRAINT chat_messages_kind_check CHECK (kind IN ('answer', 'notes', 'plan'));

-- On a notes answer: 'auto' or 'plan' means the asker's browser inserts the
-- notes when they are done; NULL means they wait for someone to click
-- Insert, which is how notes asked for before this migration behave.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS mode TEXT;

-- The document the notes are for — the one open when they were asked for.
-- They are inserted only while that document is the one open, so switching
-- documents while they are written does not land them in the wrong place.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS document_id UUID
    REFERENCES documents(id) ON DELETE SET NULL;

-- On a plan answer: the outline, [{heading, summary, pages: [n]}]. On a notes
-- answer written from a plan: the outline as it was approved, which the
-- worker follows.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS outline JSONB;

-- When the notes went into the document, and by whom. Set through a
-- conditional UPDATE before the browser inserts, so two tabs — or two people
-- — seeing the same finished notes cannot both insert them. On a plan
-- answer, when the plan was approved: an approved plan cannot be approved
-- again.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS applied_by UUID
    REFERENCES users(id) ON DELETE SET NULL;
