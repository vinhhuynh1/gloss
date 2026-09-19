import { env } from "./env";
import { getSession, signOut } from "./session";

export class ApiError extends Error {
  /**
   * `status` is the HTTP status, or 0 when no response arrived at all — see
   * the catch in apiFetch. 0 is not a real status, so a call site testing for
   * a specific code can never confuse the two.
   */
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * fetch() against the API with the caller's access token attached.
 *
 * getSession() is called per request on purpose: supabase-js refreshes the
 * token in the background, so a token captured once at mount goes stale and
 * every later call 401s.
 */
export async function apiFetch<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const session = await getSession();

  if (!session) throw new ApiError(401, "Not signed in");

  // A FormData body must NOT carry an explicit Content-Type: the browser
  // generates one containing the multipart boundary it chose, and setting the
  // header by hand overwrites it with a boundary-less value the server cannot
  // parse. The upload in SourcesPanel goes through here.
  const isFormData = init.body instanceof FormData;

  let res: Response;
  try {
    res = await fetch(`${env.API_BASE_URL}${path}`, {
      ...init,
      headers: {
        ...(isFormData ? {} : { "Content-Type": "application/json" }),
        Authorization: `Bearer ${session.access_token}`,
        ...init.headers,
      },
    });
  } catch {
    // fetch() rejects, rather than resolving with a bad status, only when no
    // usable response arrived: the API is down or the host is wrong, this
    // origin is missing from its ALLOWED_ORIGINS so the preflight was refused,
    // or the response carried no CORS headers — which is what an unhandled
    // server error looks like from here, because the error path skips the
    // middleware that would have added them.
    //
    // The browser's own message for all of these is the bare "Failed to
    // fetch", and every caller renders err.message straight into the UI. That
    // string names neither the cause nor anything to try, and when it replaces
    // an identical one already on screen a failed click looks like no click at
    // all. Say which API could not be reached instead.
    throw new ApiError(
      0,
      `Can't reach the API at ${env.API_BASE_URL} — it may be down, or this ` +
        `origin may not be in its ALLOWED_ORIGINS.`
    );
  }

  if (res.status === 401) {
    // The token was rejected rather than merely absent — drop the dead
    // session so the UI falls back to the login screen instead of looping.
    await signOut();
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
