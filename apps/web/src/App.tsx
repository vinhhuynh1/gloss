import { useMemo } from "react";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

import Editor from "./components/Editor";
import SuggestionSidebar from "./components/SuggestionSidebar";

// TODO: come from routing/auth once those exist. Hardcoded for local dev.
const DOCUMENT_ID = "demo-document";
const CURRENT_USER = { name: "You", color: "#6366f1" };

// Local dev: run `npx y-websocket` and point here. Swap for a managed
// provider (Liveblocks, PartyKit) before deploying — see the build-plan
// doc's architecture table for why this stays a separate process from
// the FastAPI backend rather than living inside it.
const WEBSOCKET_URL = "ws://localhost:1234";

export default function App() {
  const ydoc = useMemo(() => new Y.Doc(), []);
  const provider = useMemo(
    () => new WebsocketProvider(WEBSOCKET_URL, DOCUMENT_ID, ydoc),
    [ydoc]
  );

  return (
    <div className="app-layout">
      <Editor ydoc={ydoc} provider={provider} user={CURRENT_USER} />
      <SuggestionSidebar documentId={DOCUMENT_ID} />
    </div>
  );
}
