-- Many documents per study space.
--
-- Until now a space held exactly one document, created on demand by
-- GET /study-spaces/{id}/document. That was never a schema constraint —
-- documents has always had a study_space_id foreign key and nothing stopping
-- a second row — so this migration adds the two columns a list needs and
-- changes no existing behaviour.
--
-- Nothing is needed for apps/realtime. It keys each Yjs room on the document
-- uuid and authorizes by joining documents -> study_space_members
-- (server.js), so a second document in a space is already a separate,
-- correctly-authorized room.
--
-- Idempotent, like 001-007. Against an existing local database apply it by
-- hand:  psql "$DATABASE_URL" -f infra/migrations/008_document_titles.sql

-- A name for the tab. NOT NULL with a default so every existing row is valid
-- the moment this runs — a nullable title would push "or 'Untitled'" into
-- every reader instead.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT 'Untitled';

-- Ordering. updated_at already exists but is the wrong sort for a list: it
-- reshuffles the sidebar under the reader every time somebody types, which
-- makes the document you were about to click move. created_at is stable.
--
-- Existing rows get now(), so a space that already had one document sees it
-- dated to the migration rather than to when it was really made. That is
-- wrong and not worth a guess — updated_at on an untouched document is the
-- only other evidence and it is no better.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Backs GET /study-spaces/{id}/documents, which every editor load hits.
CREATE INDEX IF NOT EXISTS documents_space_created_idx
    ON documents (study_space_id, created_at);
