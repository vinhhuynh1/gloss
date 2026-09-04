import { useState } from "react";

import { useAuth } from "./auth/AuthProvider";
import LoginScreen from "./auth/LoginScreen";
import SpaceListPage from "./pages/SpaceListPage";
import SpacePage from "./pages/SpacePage";
import type { StudySpace } from "./lib/types";

// No router yet: one piece of state covers "list" vs "one space", and
// skipping react-router also means the static host needs no SPA-fallback
// rewrite rules. Deep links are a week-2 concern.
export default function App() {
  const { loading, session } = useAuth();
  const [space, setSpace] = useState<StudySpace | null>(null);

  if (loading) return <p className="muted centered">Loading…</p>;
  if (!session) return <LoginScreen />;

  return space ? (
    <SpacePage space={space} onBack={() => setSpace(null)} />
  ) : (
    <SpaceListPage onOpen={setSpace} />
  );
}
