import { useEffect, useState } from "react";
import type { WebsocketProvider } from "y-websocket";

import type { ConnectionStatus } from "../lib/useCollabProvider";

interface Peer {
  clientId: number;
  name?: string;
  color?: string;
}

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  connecting: "Connecting…",
  syncing: "Syncing…",
  synced: "Live",
  // States the sentence, rather than just naming the state: this is the
  // user-facing form of the guarantee the CRDT actually provides.
  offline: "Offline — edits are kept and will sync when you reconnect",
  denied: "Can't join this document — you may have been removed from the space",
};

/**
 * Who is connected right now, and whether we ourselves are.
 *
 * Reads provider.awareness directly rather than
 * editor.storage.collaborationCursor.users. The extension assigns that array
 * from inside its own awareness handler, which React knows nothing about, so
 * it never triggers a re-render — reading it would mean polling. Awareness is
 * a y-protocols Observable that fans out to any number of subscribers, so
 * listening here runs alongside the extension rather than competing with it,
 * and needs no editor instance.
 */
export default function PresenceBar({
  provider,
  status,
}: {
  provider: WebsocketProvider;
  status: ConnectionStatus;
}) {
  const [peers, setPeers] = useState<Peer[]>([]);

  useEffect(() => {
    const read = () =>
      setPeers(
        [...provider.awareness.getStates().entries()]
          .map(([clientId, state]) => ({
            clientId,
            ...((state as { user?: { name?: string; color?: string } }).user ??
              {}),
          }))
          // CollaborationCursor sets the `user` field when the editor builds
          // its ProseMirror plugins, so a peer that has connected but not yet
          // mounted its editor is briefly nameless. Skip it rather than
          // render a blank chip that flickers into a real one.
          .filter((p) => p.name)
      );

    read();
    // 'change', not 'update': 'update' also fires on the awareness heartbeat
    // every few seconds, which would re-render this roster constantly for no
    // change at all.
    provider.awareness.on("change", read);
    return () => provider.awareness.off("change", read);
  }, [provider]);

  return (
    <div className="presence-bar">
      {/* One chip per clientId, not per user. Two tabs signed in as the same
          person are two chips — which is exactly the visible proof that the
          second tab really connected. */}
      <div className="presence-chips">
        {peers.map((peer) => (
          <span
            key={peer.clientId}
            className={
              peer.clientId === provider.doc.clientID
                ? "presence-chip is-self"
                : "presence-chip"
            }
            style={{ backgroundColor: peer.color }}
            title={
              peer.clientId === provider.doc.clientID
                ? `${peer.name} (you)`
                : peer.name
            }
          >
            {peer.name?.slice(0, 1).toUpperCase()}
          </span>
        ))}
      </div>

      <span className={`conn-badge is-${status}`} title={STATUS_TEXT[status]}>
        {status === "synced"
          ? `${peers.length} here now`
          : STATUS_TEXT[status]}
      </span>
    </div>
  );
}
