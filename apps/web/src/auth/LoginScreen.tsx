import { useState } from "react";

import { env } from "../lib/env";
import { signIn } from "../lib/session";

/**
 * Email + password, deliberately not magic links.
 *
 * Supabase's built-in SMTP on the free tier is rate-limited to a couple of
 * messages an hour, so a magic-link flow locks you out exactly when you are
 * demoing it. Passwords cost a little more UI and no email at all.
 *
 * Turn OFF "Confirm email" in Supabase -> Authentication -> Sign In / Providers,
 * or sign-up dead-ends on that same limit.
 *
 * Under VITE_DEV_AUTH the password field disappears entirely — the API issues
 * a token for any address with no account and no verification, so asking for
 * a password would be theatre. See apps/api/routers/dev_auth.py.
 */
export default function LoginScreen() {
  const devAuth = env.DEV_AUTH;
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Dev auth has no accounts to create, so the signin/signup distinction has
  // nothing to switch on.
  const showName = devAuth || mode === "signup";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signIn({
        email,
        password,
        name,
        signUp: !devAuth && mode === "signup",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <h1>Study Notes</h1>

        {devAuth ? (
          // Deliberately loud. A screenshot of this screen must never be
          // mistaken for the real sign-in.
          <p className="dev-auth-banner">
            Dev auth is on — any email works, no password, no account created.
          </p>
        ) : (
          <p className="muted">
            {mode === "signin"
              ? "Sign in to your study spaces."
              : "Create an account to get started."}
          </p>
        )}

        {showName && (
          <label>
            Display name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="How classmates will see you"
              autoComplete="name"
            />
          </label>
        )}

        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            placeholder={devAuth ? "ada@test.local" : undefined}
          />
        </label>

        {!devAuth && (
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              autoComplete={
                mode === "signin" ? "current-password" : "new-password"
              }
            />
          </label>
        )}

        {error && <p className="error">{error}</p>}

        <button type="submit" disabled={busy}>
          {busy ? "…" : devAuth ? "Continue" : mode === "signin" ? "Sign in" : "Sign up"}
        </button>

        {!devAuth && (
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setMode(mode === "signin" ? "signup" : "signin");
              setError(null);
            }}
          >
            {mode === "signin"
              ? "Need an account? Sign up"
              : "Already have an account? Sign in"}
          </button>
        )}
      </form>
    </div>
  );
}
