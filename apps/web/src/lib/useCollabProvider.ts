/**
 * Owns everything with a socket lifetime: the Y.Doc, the WebSocket provider,
 * the connection status, and keeping the provider's auth token fresh.
 *
 * This moved out of SpacePage rather than being invented here — the page was
 * carrying a document CRDT, a socket, and a teardown path alongside its
 * rendering, and the token and status work below all attaches to the same
 * object graph.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

import { env } from "./env";
import { supabase } from "./supabase";

export type ConnectionStatus =
  /** No provider yet, or the socket is opening. */
  | "connecting"
  /** Socket open, first sync round trip not finished. */
  | "syncing"
  /** Sync step 1 done — what you see is what the server has. */
  | "synced"
  /** Socket closed; a backoff retry is pending. Edits still merge on return. */
  | "offline"
  /** The server is up and refusing us: auth expired, or access was removed. */
  | "denied";

/**
 * The client cannot see the status an upgrade was refused with — a rejected
 * WebSocket surfaces as an opaque error event and close code 1006. So the
 * only way to separate "we lost access" from "the server is down" is to ask
 * the server whether it is up. apps/realtime serves GET /health with an
 * allow-origin header for exactly this.
 */
async function serverIsUp(): Promise<boolean> {
  try {
    const res = await fetch(env.WS_HEALTH_URL, { cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

/** Probe only after this many consecutive failures with no successful open. */
const PROBE_AFTER_FAILURES = 2;

export interface Collab {
  ydoc: Y.Doc;
  provider: WebsocketProvider | null;
  status: ConnectionStatus;
}

export function useCollabProvider(
  documentId: string | undefined,
  accessToken: string | undefined
): Collab {
  // Keyed on the document: switching spaces must not carry one document's
  // CRDT state into another's.
  const ydoc = useMemo(() => new Y.Doc(), [documentId]);
  const [provider, setProvider] = useState<WebsocketProvider | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");

  // The object handed to the provider as `params`. y-websocket rebuilds its
  // connection URL from this on every reconnect attempt (its `get url()`),
  // and its constructor documents the object as safe to mutate — so keeping
  // the token current is a write into this ref, not a new provider.
  const paramsRef = useRef<{ token: string } | null>(null);

  useEffect(() => {
    if (!documentId) return;

    // The token goes in a query param because the browser WebSocket API
    // cannot set headers. apps/realtime verifies it on upgrade and checks the
    // caller is a member of the space owning this document.
    let cancelled = false;
    let created: WebsocketProvider | null = null;
    let failures = 0;

    void (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (cancelled || !session) return;

      const params = { token: session.access_token };
      paramsRef.current = params;

      created = new WebsocketProvider(env.WS_URL, documentId, ydoc, { params });

      created.on("status", ({ status: s }: { status: string }) => {
        if (s === "connected") {
          failures = 0;
          // Not "synced": the socket is open, which is not the same as the
          // first sync round trip having completed. provider.synced is reset
          // to false on every reconnect, so this stays honest across drops.
          setStatus("syncing");
        } else if (s === "connecting") {
          setStatus((prev) => (prev === "denied" ? prev : "connecting"));
        } else if (s === "disconnected") {
          setStatus((prev) => (prev === "denied" ? prev : "offline"));
        }
      });

      created.on("sync", (isSynced: boolean) => {
        setStatus(isSynced ? "synced" : "syncing");
      });

      created.on("connection-close", () => {
        // A socket that dropped after the token expired would otherwise
        // replay the dead token through every backoff retry. getSession()
        // returns the cached token, refreshing it first if it is past expiry.
        void supabase.auth.getSession().then(({ data }) => {
          if (paramsRef.current && data.session) {
            paramsRef.current.token = data.session.access_token;
          }
        });
      });

      created.on("connection-error", () => {
        failures += 1;
        if (failures < PROBE_AFTER_FAILURES) {
          setStatus("offline");
          return;
        }
        void serverIsUp().then((up) => {
          if (cancelled) return;
          // Server up but refusing the upgrade means a gate rejected us.
          // Not terminal: a later retry that succeeds moves us back to
          // syncing/synced through the handlers above.
          setStatus(up ? "denied" : "offline");
        });
      });

      setProvider(created);
    })();

    // Without this the socket leaks on every space switch and leaves ghost
    // cursors behind for other collaborators.
    return () => {
      cancelled = true;
      created?.destroy();
      paramsRef.current = null;
      setProvider(null);
      setStatus("connecting");
    };
    // `accessToken` is deliberately NOT a dependency: rotating the token must
    // not tear down and rebuild the socket. The effect below handles it.
  }, [documentId, ydoc]);

  useEffect(() => {
    // supabase-js rotates the access token roughly hourly, and AuthProvider
    // already re-renders on TOKEN_REFRESHED, so no second subscription is
    // needed here. Mutating `params` is enough: the live socket is untouched
    // and the next reconnect carries the fresh token.
    //
    // Replacing the provider object instead would be worse than wasteful.
    // Editor.tsx calls useEditor() with no deps, so @tiptap/react merges the
    // new options rather than rebuilding the editor — and CollaborationCursor
    // captures provider.awareness once, when its ProseMirror plugin is built.
    // A replacement provider would be ignored and every remote cursor would
    // go silently dead.
    if (paramsRef.current && accessToken) {
      paramsRef.current.token = accessToken;
    }
  }, [accessToken]);

  return { ydoc, provider, status };
}
