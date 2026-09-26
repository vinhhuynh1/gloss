import { useAuth } from "./auth/AuthProvider";
import LoginScreen from "./auth/LoginScreen";
import SpaceListPage from "./pages/SpaceListPage";
import SpacePage from "./pages/SpacePage";
import { navigate, spaceIdFromRoute, useHashRoute } from "./lib/useHashRoute";

export default function App() {
  const { loading, session } = useAuth();
  const route = useHashRoute();
  const spaceId = spaceIdFromRoute(route);

  // Nothing is known yet - not even whether there is a session - so this is
  // deliberately a blank hold rather than a skeleton of a screen that may
  // turn out to be the login form instead.
  if (loading) return <div className="boot-hold" aria-busy="true" />;

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
