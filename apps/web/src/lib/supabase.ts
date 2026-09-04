import { createClient } from "@supabase/supabase-js";

import { env } from "./env";

// Persists the session to localStorage and refreshes the access token in the
// background. That refresh is why apiFetch asks for the session on every call
// rather than holding a token in a module variable — a cached token goes
// stale after an hour and every request starts 401ing.
export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
});
