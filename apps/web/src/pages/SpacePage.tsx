import { useEffect, useMemo, useState } from "react";

import Editor from "../components/Editor";
import PresenceBar from "../components/PresenceBar";
import SuggestionSidebar from "../components/SuggestionSidebar";
import { useAuth } from "../auth/AuthProvider";
import { ApiError, apiFetch } from "../lib/api";
import { useCollabProvider } from "../lib/useCollabProvider";
import type { Member, SpaceDocument, StudySpace } from "../lib/types";

/** Stable per-user cursor colour, so a collaborator looks the same each session. */
function colorFromUserId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(hash) % 360}, 70%, 55%)`;
}

export default function SpacePage({
  spaceId,
  onBack,
}: {
  spaceId: string;
  onBack: () => void;
}) {
  const { user, session } = useAuth();
  const [space, setSpace] = useState<StudySpace | null>(null);
  const [doc, setDoc] = useState<SpaceDocument | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    let active = true;
    // The space itself is fetched rather than passed in: on a pasted deep
    // link there is no StudySpace object in memory to pass. The endpoint is
    // membership-guarded (apps/api/authz.py), so a non-member following a
    // shared link gets a clean 403 here rather than an empty editor.
    Promise.all([
      apiFetch<StudySpace>(`/study-spaces/${spaceId}`),
      apiFetch<SpaceDocument>(`/study-spaces/${spaceId}/document`),
      apiFetch<Member[]>(`/study-spaces/${spaceId}/members`),
    ])
      .then(([s, d, m]) => {
        if (!active) return;
        setSpace(s);
        setDoc(d);
        setMembers(m);
      })
      .catch((err) => {
        if (!active) return;
        if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
          setDenied(true);
        } else {
          setError(err instanceof Error ? err.message : "Failed to load space");
        }
      });
    return () => {
      active = false;
    };
  }, [spaceId]);

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

  const { ydoc, provider, status } = useCollabProvider(
    doc?.id,
    session?.access_token
  );

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    try {
      const member = await apiFetch<Member>(`/study-spaces/${spaceId}/members`, {
        method: "POST",
        body: JSON.stringify({ email: inviteEmail.trim() }),
      });
      setInviteEmail("");
      setMembers((prev) =>
        prev.some((m) => m.user_id === member.user_id) ? prev : [...prev, member]
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invite failed");
    }
  }

  if (denied) {
    return (
      <div className="space-page">
        <header className="app-header">
          <button className="link-button" onClick={onBack}>
            ← All spaces
          </button>
        </header>
        <p className="muted">
          You don't have access to this study space. Ask whoever shared the link
          to invite you.
        </p>
      </div>
    );
  }

  return (
    <div className="space-page">
      <header className="app-header">
        <button className="link-button" onClick={onBack}>
          ← All spaces
        </button>
        <h1>{space?.course_name ?? "…"}</h1>
        {/* Two counts that answer different questions, deliberately. This one
            is who belongs to the space (from the API); PresenceBar's is who is
            connected right now (from CRDT awareness). */}
        <span className="muted">
          {members.length} member{members.length === 1 ? "" : "s"}
        </span>
        {provider && <PresenceBar provider={provider} status={status} />}
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
          {/* Kept mounted and editable in every connection state. Yjs merges
              edits made while offline on reconnect — disabling the editor
              would trade away the "no lost edits" property for a worse
              experience. PresenceBar carries the status. */}
          <Editor ydoc={ydoc} provider={provider} user={identity} />
          <SuggestionSidebar documentId={doc.id} />
        </div>
      ) : (
        <p className="muted">Connecting…</p>
      )}
    </div>
  );
}
