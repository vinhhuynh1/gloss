-- Supabase ONLY. Apply after infra/migrations/016_guest_users.sql.
--
-- Anonymous sign-in (demo mode) creates auth.users rows with a NULL email.
-- public.users.email is NOT NULL, so the 010 version of this function would
-- raise on every anonymous signup — and a raising trigger makes Supabase fail
-- the signup with "Database error saving new user". Same function, three
-- changes: a placeholder email for anonymous users (.invalid is reserved and
-- can never be a real address; still UNIQUE because the id is), a "Guest"
-- name, and is_guest from auth's own is_anonymous flag.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    INSERT INTO public.users (id, email, name, is_guest)
    VALUES (
        new.id,
        COALESCE(NULLIF(new.email, ''), 'guest-' || new.id || '@demo.invalid'),
        COALESCE(
            new.raw_user_meta_data ->> 'name',
            NULLIF(split_part(COALESCE(new.email, ''), '@', 1), ''),
            'Guest'
        ),
        COALESCE(new.is_anonymous, false)
    )
    -- Must not raise; see 010.
    ON CONFLICT (id) DO NOTHING;
    RETURN new;
END;
$$;
