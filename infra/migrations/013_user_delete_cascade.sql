-- Deleting a user deletes everything they own.
--
-- As declared in 001, three foreign keys to users had no ON DELETE rule, so
-- any user who had created a space, uploaded a source, or resolved a
-- suggestion could not be deleted at all: the delete failed with a
-- foreign-key violation (on Supabase, "Database error deleting user").
--
--   study_spaces.created_by  CASCADE   the space goes, and with it every
--                                      document, source, chunk, suggestion,
--                                      guide, deck, comment and chat message
--                                      in it (all already cascade from the
--                                      space). Other members lose the space.
--   sources.uploaded_by      CASCADE   sources they added to someone else's
--                                      space go too, chunks included.
--   suggestions.resolved_by  SET NULL  an agent suggestion in a space that
--                                      survives keeps its outcome; only the
--                                      name of who resolved it is dropped.
--
-- Everything else referencing users already cascades or sets null.
--
-- Idempotent, like 001-012. Against an existing database apply it by hand:
--   psql "$DATABASE_URL" -f infra/migrations/013_user_delete_cascade.sql
-- On Supabase, follow it with infra/supabase/012_user_delete_cascade.sql.
--
-- Drop-then-add in one transaction, so a failure between the two cannot
-- leave a column without its constraint.
BEGIN;

ALTER TABLE study_spaces DROP CONSTRAINT IF EXISTS study_spaces_created_by_fkey;
ALTER TABLE study_spaces
    ADD CONSTRAINT study_spaces_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_uploaded_by_fkey;
ALTER TABLE sources
    ADD CONSTRAINT sources_uploaded_by_fkey
    FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE suggestions DROP CONSTRAINT IF EXISTS suggestions_resolved_by_fkey;
ALTER TABLE suggestions
    ADD CONSTRAINT suggestions_resolved_by_fkey
    FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL;

COMMIT;
