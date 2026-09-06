import { useAuth } from "./auth/AuthProvider";
import LoginScreen from "./auth/LoginScreen";
import SpaceListPage from "./pages/SpaceListPage";
import SpacePage from "./pages/SpacePage";
import { navigate, spaceIdFromRoute, useHashRoute } from "./lib/useHashRoute";

export default function App() {
  const { loading, session } = useAuth();
  const route = useHashRoute();
  const spaceId = spaceIdFromRoute(route);

  if (loading) return <p className="muted centered">Loading…</p>;

  // The hash survives the login screen, so a signed-out user opening a shared
  // link lands on that space straight after signing in — the whole "send a
  // classmate the URL" flow, with no extra code.
  if (!session) return <LoginScreen />;

  return spaceId ? (
    // key= forces a full remount when switching between spaces. SpacePage
    // owns a Y.Doc and a WebSocket, and unmount is the one teardown path
    // that is definitely correct.
    <SpacePage key={spaceId} spaceId={spaceId} onBack={() => navigate("/")} />
  ) : (
    <SpaceListPage onOpen={(space) => navigate(`/spaces/${space.id}`)} />
  );
}
