import { env } from "./env";
import { getSession, signOut } from "./session";

export class ApiError extends Error {
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

  const res = await fetch(`${env.API_BASE_URL}${path}`, {
    ...init,
    headers: {
      ...(isFormData ? {} : { "Content-Type": "application/json" }),
      Authorization: `Bearer ${session.access_token}`,
      ...init.headers,
    },
  });

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
