import { useState } from "react";

import { supabase } from "../lib/supabase";

/**
 * Email + password, deliberately not magic links.
 *
 * Supabase's built-in SMTP on the free tier is rate-limited to a couple of
 * messages an hour, so a magic-link flow locks you out exactly when you are
 * demoing it. Passwords cost a little more UI and no email at all.
 *
 * Turn OFF "Confirm email" in Supabase -> Authentication -> Sign In / Providers,
 * or sign-up dead-ends on that same limit.
 */
export default function LoginScreen() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { error } =
        mode === "signin"
          ? await supabase.auth.signInWithPassword({ email, password })
          : await supabase.auth.signUp({
              email,
              password,
              // Read by the on_auth_user_created trigger into users.name,
              // which becomes the collaborator's cursor label.
              options: { data: { name: name || email.split("@")[0] } },
            });
      if (error) setError(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <h1>Study Notes</h1>
        <p className="muted">
          {mode === "signin"
            ? "Sign in to your study spaces."
            : "Create an account to get started."}
        </p>

        {mode === "signup" && (
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
          />
        </label>

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

        {error && <p className="error">{error}</p>}

        <button type="submit" disabled={busy}>
          {busy ? "…" : mode === "signin" ? "Sign in" : "Sign up"}
        </button>

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
      </form>
    </div>
  );
}
