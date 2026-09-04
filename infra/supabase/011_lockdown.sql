-- Supabase ONLY. Closes a hole that is easy to ship without noticing.
--
-- Supabase automatically exposes every table in the `public` schema through
-- PostgREST at https://<ref>.supabase.co/rest/v1/<table>, authorized by the
-- anon key. VITE_SUPABASE_ANON_KEY is compiled into the browser bundle by
-- design, so it is public. With RLS off, anyone who views source on the
-- deployed site can read users, source_chunks, and everything else directly,
-- completely bypassing the API's authorization.
--
-- This app never uses PostgREST — the frontend talks only to FastAPI, and the
-- worker and eval harness connect over psycopg. So the correct posture is to
-- switch the whole REST surface off rather than model policies for it.
--
-- RLS enabled with ZERO policies denies the `anon` and `authenticated` roles
-- everything. The API, realtime server, agent worker, and eval all connect as
-- `postgres` over the pooler, and the table owner bypasses RLS, so none of
-- them are affected.
--
-- Deny-by-default at the edge, authorize in application code. Real per-row
-- policies are week-6 defense-in-depth, not a week-1 requirement.

ALTER TABLE public.users               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.study_spaces        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.study_space_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sources             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.source_chunks       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.suggestions         ENABLE ROW LEVEL SECURITY;

-- Verify with:
--   curl "https://<ref>.supabase.co/rest/v1/users?select=*" -H "apikey: <anon key>"
-- Expect an empty array or a permission error, never user rows.
