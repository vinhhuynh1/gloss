import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { env } from "./env";

// Persists the session to localStorage and refreshes the access token in the
// background. That refresh is why apiFetch asks for the session on every call
// rather than holding a token in a module variable — a cached token goes
// stale after an hour and every request starts 401ing.
//
// Created lazily rather than at module load: under VITE_DEV_AUTH there is no
// project URL to pass, and createClient throws on an empty one. Nothing in
// dev-auth mode ever calls this.
let client: SupabaseClient | null = null;

export function supabaseClient(): SupabaseClient {
  if (!client) {
    client = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
    });
  }
  return client;
}
