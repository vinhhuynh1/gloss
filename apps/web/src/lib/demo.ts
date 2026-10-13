/**
 * Demo mode: sign in anonymously and get (or resume) a sandbox copy of the
 * demo study space. See docs/superpowers/specs/2026-10-13-demo-mode-design.md.
 */
import { ApiError, apiFetch } from "./api";
import { env } from "./env";
import { supabaseClient } from "./supabase";
import type { StudySpace } from "./types";

/** Supabase refused the anonymous sign-in (switched off, or rate-limited). */
export class DemoAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoAuthError";
  }
}

/** Resolves to the sandbox's space id. Reuses an existing session, so a
 * refresh on /#/demo resumes the same sandbox instead of making another. */
export async function startDemo(): Promise<string> {
  if (env.DEV_AUTH) {
    throw new DemoAuthError("The demo needs Supabase auth (VITE_DEV_AUTH is on).");
  }
  const auth = supabaseClient().auth;
  const {
    data: { session },
  } = await auth.getSession();
  if (!session) {
    const { error } = await auth.signInAnonymously();
    if (error) throw new DemoAuthError(error.message);
  }
  const space = await apiFetch<StudySpace>("/demo", { method: "POST" });
  return space.id;
}

export function demoErrorMessage(err: unknown): string {
  if (err instanceof DemoAuthError) return "The demo isn't available right now.";
  if (err instanceof ApiError && err.status === 503) {
    return "The demo is busy right now — try again tomorrow.";
  }
  if (err instanceof ApiError && err.status === 403) {
    return "You're signed in, so there's no demo to start — your own spaces are on the home page.";
  }
  return "Couldn't start the demo — try again.";
}
