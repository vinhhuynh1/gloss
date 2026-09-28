-- Supabase ONLY. Run after infra/migrations/013_user_delete_cascade.sql.
--
-- Deleting a user in the Supabase dashboard removes the auth.users row. This
-- links public.users to it, so that delete now takes the mirrored row with
-- it, and 013's cascades take everything the user owned.
--
-- This is the hard FK 010_auth_sync.sql held back. Signup has since been
-- verified end to end, which is the condition that file set for adding it.
--
-- NOT VALID: existing rows are not checked, so the synthetic user from
-- apps/agent-worker/seed_demo.py (which has no auth.users row) cannot make
-- this fail. The cascade applies to every row regardless; NOT VALID only
-- skips the one-time scan. seed_demo.py stays a local-only script.
--
-- Drop-then-add in one transaction, so re-running it is safe.
BEGIN;

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_id_fkey;
ALTER TABLE public.users
    ADD CONSTRAINT users_id_fkey
    FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE
    NOT VALID;

COMMIT;
