import { env } from "./env";
import { supabase } from "./supabase";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * fetch() against the API with the caller's Supabase access token attached.
 *
 * getSession() is called per request on purpose: supabase-js refreshes the
 * token in the background, so a token captured once at mount goes stale and
 * every later call 401s.
 */
export async function apiFetch<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) throw new ApiError(401, "Not signed in");

  const res = await fetch(`${env.API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
      ...init.headers,
    },
  });

  if (res.status === 401) {
    // The token was rejected rather than merely absent — drop the dead
    // session so the UI falls back to the login screen instead of looping.
    await supabase.auth.signOut();
    throw new ApiError(401, "Session expired");
  }

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (typeof body?.detail === "string") detail = body.detail;
    } catch {
      // Non-JSON error body; the status text will do.
    }
    throw new ApiError(res.status, detail);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
