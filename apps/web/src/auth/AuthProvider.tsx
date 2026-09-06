import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  getSession,
  onSessionChange,
  signOut as sessionSignOut,
  type Session,
  type SessionUser,
} from "../lib/session";

interface AuthState {
  session: Session | null;
  user: SessionUser | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  // Starts true so an already-signed-in user never sees the login screen
  // flash while the stored session is being read back.
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    void getSession().then((next) => {
      if (!active) return;
      setSession(next);
      setLoading(false);
    });

    // Also fires on Supabase's TOKEN_REFRESHED, which is what keeps
    // session.access_token fresh for useCollabProvider's refresh effect.
    const unsubscribe = onSessionChange((next) => setSession(next));

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      session,
      user: session?.user ?? null,
      loading,
      signOut: sessionSignOut,
    }),
    [session, loading]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
