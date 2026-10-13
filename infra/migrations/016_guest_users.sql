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
