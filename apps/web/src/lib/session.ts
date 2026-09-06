/**
 * One session API over two identity backends.
 *
 * Supabase is the real one. Dev auth (VITE_DEV_AUTH=1) talks to
 * POST /dev/login on our own API instead, so the app runs against nothing but
 * the local docker-compose Postgres — no project, no email confirmation, no
 * database password. See apps/api/routers/dev_auth.py for why that is a
 * permissive issuer rather than an auth bypass.
 *
 * Everything downstream — apiFetch, AuthProvider, useCollabProvider — goes
 * through this module and never learns which backend is active.
 */
import { env } from "./env";
import { supabaseClient } from "./supabase";

export interface SessionUser {
  id: string;
  email: string;
  /** Display name, used as the collaborator's cursor label. */
  name: string;
}

export interface Session {
  access_token: string;
  user: SessionUser;
}

type Listener = (session: Session | null) => void;

/* --- dev backend --- */

const DEV_STORAGE_KEY = "study-notes.dev-session";
const devListeners = new Set<Listener>();

function readDevSession(): Session | null {
  try {
    const raw = localStorage.getItem(DEV_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    // Private mode, cleared storage, or a shape from an older build.
    return null;
  }
}

function writeDevSession(session: Session | null) {
  try {
    if (session) localStorage.setItem(DEV_STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(DEV_STORAGE_KEY);
  } catch {
    // Non-fatal: the session just will not survive a reload.
  }
  devListeners.forEach((fn) => fn(session));
}

async function devSignIn(email: string, name: string): Promise<void> {
  // Not apiFetch: that attaches a token, and we are here precisely because
  // there isn't one yet.
  const res = await fetch(`${env.API_BASE_URL}/dev/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, name: name || undefined }),
  });

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (typeof body?.detail === "string") detail = body.detail;
      else if (Array.isArray(body?.detail)) detail = "That doesn't look like an email address";
    } catch {
      // Non-JSON body; status text will do.
    }
    if (res.status === 404) {
      detail =
        "The API has no /dev/login route. Set DEV_AUTH_SECRET in apps/api/.env and restart it.";
    }
    throw new Error(detail);
  }

  writeDevSession((await res.json()) as Session);
}

/* --- public API --- */

export async function getSession(): Promise<Session | null> {
  if (env.DEV_AUTH) return readDevSession();

  const {
    data: { session },
  } = await supabaseClient().auth.getSession();
  if (!session) return null;

  const meta = session.user.user_metadata as { name?: string } | undefined;
  const email = session.user.email ?? "";
  return {
    access_token: session.access_token,
    user: {
      id: session.user.id,
      email,
      name: meta?.name ?? email ?? "Anonymous",
    },
  };
}

/** Subscribe to sign-in/sign-out (and, on Supabase, token rotation). */
export function onSessionChange(fn: Listener): () => void {
  if (env.DEV_AUTH) {
    devListeners.add(fn);
    return () => devListeners.delete(fn);
  }

  const {
    data: { subscription },
  } = supabaseClient().auth.onAuthStateChange(() => {
    // Re-read through getSession() so subscribers always see our own shape
    // rather than Supabase's.
    void getSession().then(fn);
  });
  return () => subscription.unsubscribe();
}

/**
 * Dev auth: `password` is ignored and no account is created — any address
 * works. Supabase: the existing email+password sign-in or sign-up.
 */
export async function signIn(opts: {
  email: string;
  password?: string;
  name?: string;
  signUp?: boolean;
}): Promise<void> {
  if (env.DEV_AUTH) {
    await devSignIn(opts.email, opts.name ?? "");
    return;
  }

  const auth = supabaseClient().auth;
  const { error } = opts.signUp
    ? await auth.signUp({
        email: opts.email,
        password: opts.password ?? "",
        // Read by the on_auth_user_created trigger into users.name, which
        // becomes the collaborator's cursor label.
        options: { data: { name: opts.name || opts.email.split("@")[0] } },
      })
    : await auth.signInWithPassword({
        email: opts.email,
        password: opts.password ?? "",
      });

  if (error) throw new Error(error.message);
}

export async function signOut(): Promise<void> {
  if (env.DEV_AUTH) {
    writeDevSession(null);
    return;
  }
  await supabaseClient().auth.signOut();
}
