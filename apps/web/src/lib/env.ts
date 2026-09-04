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

export const env = {
  SUPABASE_URL: required("VITE_SUPABASE_URL", import.meta.env.VITE_SUPABASE_URL),
  SUPABASE_ANON_KEY: required(
    "VITE_SUPABASE_ANON_KEY",
    import.meta.env.VITE_SUPABASE_ANON_KEY
  ),
  API_BASE_URL: required(
    "VITE_API_BASE_URL",
    import.meta.env.VITE_API_BASE_URL
  ).replace(/\/$/, ""),
  WS_URL: required("VITE_WS_URL", import.meta.env.VITE_WS_URL).replace(/\/$/, ""),
};
