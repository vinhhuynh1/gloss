import { useEffect, useMemo, useState } from "react";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

import Editor from "../components/Editor";
import SuggestionSidebar from "../components/SuggestionSidebar";
import { useAuth } from "../auth/AuthProvider";
import { apiFetch } from "../lib/api";
import { env } from "../lib/env";
import { supabase } from "../lib/supabase";
import type { Member, SpaceDocument, StudySpace } from "../lib/types";

/** Stable per-user cursor colour, so a collaborator looks the same each session. */
function colorFromUserId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(hash) % 360}, 70%, 55%)`;
}

export default function SpacePage({
  space,
  onBack,
}: {
  space: StudySpace;
  onBack: () => void;
}) {
  const { user } = useAuth();
  const [doc, setDoc] = useState<SpaceDocument | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([
      apiFetch<SpaceDocument>(`/study-spaces/${space.id}/document`),
      apiFetch<Member[]>(`/study-spaces/${space.id}/members`),
    ])
      .then(([d, m]) => {
        if (!active) return;
        setDoc(d);
        setMembers(m);
      })
      .catch((err) => active && setError(err.message));
    return () => {
      active = false;
    };
  }, [space.id]);

  const identity = useMemo(
    () =>
      user
        ? {
            name:
              (user.user_metadata?.name as string | undefined) ??
              user.email ??
              "Anonymous",
            color: colorFromUserId(user.id),
          }
        : null,
    [user]
  );

  const ydoc = useMemo(() => new Y.Doc(), [doc?.id]);
  const [provider, setProvider] = useState<WebsocketProvider | null>(null);

  useEffect(() => {
    if (!doc) return;

    // The token is passed as a query param because the browser WebSocket API
    // cannot set headers. apps/realtime verifies it on upgrade and checks the
    // caller is a member of the space owning this document.
    let cancelled = false;
    let created: WebsocketProvider | null = null;

    void (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (cancelled || !session) return;

      created = new WebsocketProvider(env.WS_URL, doc.id, ydoc, {
        params: { token: session.access_token },
      });
      setProvider(created);
    })();

    // Without this the socket leaks on every space switch and leaves ghost
    // cursors behind for other collaborators.
    return () => {
      cancelled = true;
      created?.destroy();
      setProvider(null);
    };
  }, [doc, ydoc]);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    try {
      const member = await apiFetch<Member>(
        `/study-spaces/${space.id}/members`,
        { method: "POST", body: JSON.stringify({ email: inviteEmail.trim() }) }
      );
      setInviteEmail("");
      setMembers((prev) =>
        prev.some((m) => m.user_id === member.user_id) ? prev : [...prev, member]
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invite failed");
    }
  }

  return (
    <div className="space-page">
      <header className="app-header">
        <button className="link-button" onClick={onBack}>
          ← All spaces
        </button>
        <h1>{space.course_name}</h1>
        <span className="muted">
          {members.length} member{members.length === 1 ? "" : "s"}
        </span>
      </header>

      <form className="invite-form" onSubmit={invite}>
        <input
          type="email"
          value={inviteEmail}
          onChange={(e) => setInviteEmail(e.target.value)}
          placeholder="Invite a classmate by email"
        />
        <button type="submit">Invite</button>
      </form>

      {error && <p className="error">{error}</p>}

      {doc && identity && provider ? (
        <div className="app-layout">
          <Editor ydoc={ydoc} provider={provider} user={identity} />
          <SuggestionSidebar documentId={doc.id} />
        </div>
      ) : (
        <p className="muted">Connecting…</p>
      )}
    </div>
  );
}
