import { useCallback, useEffect, useRef, useState } from "react";

import Orb from "../components/Orb";
import { demoErrorMessage, startDemo } from "../lib/demo";
import { navigate } from "../lib/useHashRoute";

/** /#/demo — signs in anonymously, copies the demo space, opens it. */
export default function DemoStart() {
  const [error, setError] = useState<string | null>(null);
  // StrictMode runs effects twice in development; one attempt per mount.
  const started = useRef(false);

  const run = useCallback(async () => {
    setError(null);
    try {
      const spaceId = await startDemo();
      navigate(`/spaces/${spaceId}`);
    } catch (err) {
      setError(demoErrorMessage(err));
    }
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run();
  }, [run]);

  return (
    <main className="demo-start" aria-busy={error === null}>
      {error === null ? (
        <>
          <span className="demo-start-well">
            <Orb activity="building" size={64} />
          </span>
          <p className="demo-start-status" role="status">
            Setting up your demo…
          </p>
        </>
      ) : (
        <>
          <p className="error" role="alert">
            {error}
          </p>
          <div className="demo-start-actions">
            <button type="button" className="neu-button" onClick={() => void run()}>
              Try again
            </button>
            <button type="button" className="link-button" onClick={() => navigate("/")}>
              Back to sign in
            </button>
          </div>
        </>
      )}
    </main>
  );
}
