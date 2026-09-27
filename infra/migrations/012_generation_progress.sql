-- Progress for study guides and flashcard decks while they are written.
--
-- A guide is a retrieval per section of the notes and then one long model
-- call, and all the editor could say for the minute or more that takes was
-- "Writing study guide…" — indistinguishable from a worker that is not
-- running at all. The worker now records what it is doing and roughly how
-- far along it is, and the editor polls it with the status it already polls.
--
-- progress is 0-100 and an estimate while the model is writing (see
-- apps/agent-worker/progress.py); it never reaches 100 before the row is done.
--
-- Idempotent, like 001-011. Against an existing local database apply it by
-- hand:  psql "$DATABASE_URL" -f infra/migrations/012_generation_progress.sql
--
-- The API and worker both check for these columns and carry on without
-- progress when they are missing, so deploying code before this migration
-- costs the progress bar and nothing else.

ALTER TABLE study_guides ADD COLUMN IF NOT EXISTS progress SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE study_guides ADD COLUMN IF NOT EXISTS stage TEXT;

ALTER TABLE flashcard_sets ADD COLUMN IF NOT EXISTS progress SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE flashcard_sets ADD COLUMN IF NOT EXISTS stage TEXT;
