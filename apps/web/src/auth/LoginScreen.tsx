import { useId, useState } from "react";

import { IconHide, IconShow } from "../components/Icon";
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

/** Where the disc is in a sign-in/sign-up flip. The mode changes at the
 * midpoint, edge-on, so neither face is ever seen with the other's fields. */
type Flip = "idle" | "leaving" | "arriving";

export default function LoginScreen() {
  const devAuth = env.DEV_AUTH;
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [shaking, setShaking] = useState(false);
  const [flip, setFlip] = useState<Flip>("idle");
  const nameId = useId();
  const emailId = useId();
  const passwordId = useId();

  // Dev auth has no accounts to create, so the signin/signup distinction has
  // nothing to switch on.
  const showName = devAuth || mode === "signup";

  function toggleMode() {
    setError(null);
    // Reduced motion has no flip, and so no animationend to finish it on.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setMode((m) => (m === "signin" ? "signup" : "signin"));
      return;
    }
    setFlip("leaving");
  }

  function onAnimationEnd(e: React.AnimationEvent<HTMLFormElement>) {
    // Fields and the button run animations of their own, and those bubble.
    if (e.target !== e.currentTarget) return;
    if (e.animationName === "disc-leave") {
      setMode((m) => (m === "signin" ? "signup" : "signin"));
      setFlip("arriving");
    } else if (e.animationName === "disc-arrive") {
      setFlip("idle");
    } else {
      setShaking(false);
    }
  }

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
      setShaking(true);
    } finally {
      setBusy(false);
    }
  }

  const discClass = [
    "login-disc",
    shaking && "is-shaking",
    flip === "leaving" && "is-leaving",
    flip === "arriving" && "is-arriving",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="login-screen">
      <div className="login-shell">
        {/* The perspective lives on a wrapper, not the disc: a transform on
            the element that also owns the perspective flattens the flip. */}
        <div className="login-disc-stage">
          <form className={discClass} onSubmit={submit} onAnimationEnd={onAnimationEnd}>
            <div className="login-disc-body">
              <h1>Gloss</h1>

              {devAuth ? (
                // Deliberately loud. A screenshot of this screen must never be
                // mistaken for the real sign-in.
                <p className="dev-auth-banner">
                  Dev auth is on: any email works, no password, no account created.
                </p>
              ) : (
                <p className="login-subtitle">
                  {mode === "signin"
                    ? "Sign in to your study spaces."
                    : "Create an account to get started."}
                </p>
              )}

              {/* The same outlined fields as the invite form: the label rests
                  inside the box and lifts into the border on focus or once
                  there is text. The placeholder is a single space only so CSS
                  can tell empty from filled with :placeholder-shown. */}
              {showName && (
                <div className="outlined-field">
                  <input
                    id={nameId}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoComplete="name"
                    placeholder=" "
                  />
                  <label htmlFor={nameId}>Display name</label>
                </div>
              )}

              <div className="outlined-field">
                <input
                  id={emailId}
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  placeholder=" "
                />
                <label htmlFor={emailId}>Email</label>
              </div>

              {!devAuth && (
                <div className="outlined-field password-field">
                  <input
                    id={passwordId}
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={6}
                    autoComplete={
                      mode === "signin" ? "current-password" : "new-password"
                    }
                    placeholder=" "
                  />
                  <label htmlFor={passwordId}>Password</label>
                  <button
                    type="button"
                    className="icon-button is-small"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    aria-pressed={showPassword}
                    onClick={() => setShowPassword((v) => !v)}
                  >
                    {showPassword ? <IconHide size={15} /> : <IconShow size={15} />}
                  </button>
                </div>
              )}

              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}

              <button type="submit" className="neu-button" disabled={busy}>
                {busy
                  ? mode === "signup" && !devAuth
                    ? "Creating account…"
                    : "Signing in…"
                  : devAuth
                    ? "Continue"
                    : mode === "signin"
                      ? "Sign in"
                      : "Sign up"}
              </button>

              {!devAuth && (
                <button
                  type="button"
                  className="link-button login-switch"
                  disabled={flip !== "idle"}
                  onClick={toggleMode}
                >
                  {mode === "signin" ? (
                    <>
                      Need an account? <strong>Sign up</strong>
                    </>
                  ) : (
                    <>
                      Already have an account? <strong>Sign in</strong>
                    </>
                  )}
                </button>
              )}
            </div>
          </form>
        </div>

        <p className="login-tagline">
          Write notes together. The agent cites only your sources.
        </p>
      </div>
    </div>
  );
}
