-- Demo mode (docs/superpowers/specs/2026-10-13-demo-mode-design.md).
--
-- is_guest marks a Supabase anonymous identity. Set by the signup trigger
-- (infra/supabase/013_guest_signups.sql) and by auth.py's just-in-time
-- upsert. The worker's housekeeping deletes guests older than 24 hours; the
-- 013 cascade takes their sandbox with them.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_guest BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS users_guest_created_idx ON users (created_at) WHERE is_guest;

-- is_demo marks a sandbox copied by POST /demo: counted for the daily cap,
-- and read by the web app to show the demo banner.
ALTER TABLE study_spaces ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS study_spaces_demo_created_idx ON study_spaces (created_at) WHERE is_demo;

-- One row per AI request a guest makes, written by authz.require_quota under a
-- per-guest advisory lock in the request's own transaction. Counted instead of
-- the job rows themselves because those can be deleted (a deleted document
-- cascades its checks, guides and quizzes), which would hand the allowance
-- back. Keyed to the user, so housekeeping's delete takes it with the guest.
CREATE TABLE IF NOT EXISTS guest_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS guest_usage_user_kind_idx ON guest_usage (user_id, kind);
