/**
 * Build-time configuration.
 *
 * Vite substitutes `undefined` for a VITE_* variable that was not set at
 * build time, with no warning. That turns into `fetch("undefined/study-spaces")`
 * and a WebSocket to "undefined" in a deployed bundle — a class of failure
 * that only shows up in production, because local development has a .env.
 * Failing at module load instead makes a misconfigured build obvious on the
 * first page view.
 */
function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy apps/web/.env.example to .env.local for local ` +
        `development, or set it as a build variable in the deployment. ` +
        `VITE_* values are baked in at build time, not read at runtime.`
    );
  }
  return value;
}

const WS_URL = required("VITE_WS_URL", import.meta.env.VITE_WS_URL).replace(
  /\/$/,
  ""
);

// Local development against no Supabase project at all — see lib/session.ts
// and apps/api/routers/dev_auth.py. Compared against "1" rather than coerced,
// so a stray "false" or "0" cannot switch it on.
const DEV_AUTH = import.meta.env.VITE_DEV_AUTH === "1";

/** Required unless dev auth is on, in which case Supabase is never contacted. */
function requiredUnlessDevAuth(name: string, value: string | undefined): string {
  return DEV_AUTH ? (value ?? "") : required(name, value);
}

export const env = {
  DEV_AUTH,
  SUPABASE_URL: requiredUnlessDevAuth(
    "VITE_SUPABASE_URL",
    import.meta.env.VITE_SUPABASE_URL
  ),
  SUPABASE_ANON_KEY: requiredUnlessDevAuth(
    "VITE_SUPABASE_ANON_KEY",
    import.meta.env.VITE_SUPABASE_ANON_KEY
  ),
  API_BASE_URL: required(
    "VITE_API_BASE_URL",
    import.meta.env.VITE_API_BASE_URL
  ).replace(/\/$/, ""),
  WS_URL,

  // Derived rather than a fifth variable: it is always the same host as
  // VITE_WS_URL, and two variables that must agree are two variables that
  // eventually will not. ws:// -> http:// and wss:// -> https:// both fall
  // out of the same replace. See useCollabProvider for what probes it.
  WS_HEALTH_URL: `${WS_URL.replace(/^ws/, "http")}/health`,
};
