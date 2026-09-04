-- Supabase ONLY. Do not run against the local docker-compose database:
-- `auth.users` does not exist on the ankane/pgvector image, so this would
-- abort local first-boot. That is why infra/supabase/ sits outside the
-- directory docker-compose mounts.
--
-- Mirrors a Supabase Auth identity into the app's own `users` table, using
-- the SAME uuid on both sides. Because the ids are identical, a JWT's `sub`
-- claim IS public.users.id — no lookup table, no translation layer, and no
-- extra query on the hot path.
--
-- Why mirror rather than foreign-key straight at auth.users:
--   * apps/agent-worker/seed_demo.py creates a synthetic seed user with a
--     plain INSERT. You cannot INSERT INTO auth.users from SQL (it needs the
--     GoTrue admin API), so FK-ing there would break the eval fixture.
--   * The local docker-compose path has no auth schema at all, and the
--     worker and eval harness are staying local on purpose.
--   * users.name is a plain column here; under auth.users it is buried in
--     raw_user_meta_data JSONB, and week 2 needs it for cursor labels.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    INSERT INTO public.users (id, email, name)
    VALUES (
        new.id,
        new.email,
        COALESCE(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1))
    )
    -- Must not raise. A trigger that errors here makes Supabase signup fail
    -- with the famously unhelpful "Database error saving new user".
    ON CONFLICT (id) DO NOTHING;
    RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- The hard FK is deliberately NOT added here. Add it only after verifying a
-- signup round-trips end to end, or a failure mode in the trigger becomes a
-- failure mode in signup:
--
--   ALTER TABLE public.users
--       ADD CONSTRAINT users_id_fkey
--       FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
--
-- Note it would also block seed_demo.py's synthetic user, which has no
-- auth.users row.
