import type { Editor as TiptapEditor } from "@tiptap/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { WebsocketProvider } from "y-websocket";
import type * as Y from "yjs";

import CommentComposer from "../components/CommentComposer";
import CommentsSidebar from "../components/CommentsSidebar";
import DocumentOutline from "../components/DocumentOutline";
import Editor from "../components/Editor";
import PresenceBar from "../components/PresenceBar";
import SourcesPanel from "../components/SourcesPanel";
import StudyGuideView from "../components/StudyGuideView";
import SuggestionSidebar from "../components/SuggestionSidebar";
import ThemeToggle from "../components/ThemeToggle";
import { useAuth } from "../auth/AuthProvider";
import { ApiError, apiFetch } from "../lib/api";
import type { PassageAnchor } from "../lib/anchors";
import { applySuggestion } from "../lib/applySuggestion";
import { useCollabProvider } from "../lib/useCollabProvider";
import { useComments } from "../lib/useComments";
import { useStudyGuide } from "../lib/useStudyGuide";
import { useSuggestions } from "../lib/useSuggestions";
import type { Member, SpaceDocument, StudySpace, Suggestion } from "../lib/types";

/** Stable per-user cursor colour, so a collaborator looks the same each session. */
function colorFromUserId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(hash) % 360}, 70%, 55%)`;
}

/**
 * The three rails: what the agent may cite, what the group wrote, what the
 * agent proposes. Split out of SpacePage so it mounts only once the document
 * id is known — everything about suggestions is keyed on it.
 */
function Workspace({
  spaceId,
  documentId,
  ydoc,
  provider,
  identity,
  members,
  currentUserId,
}: {
  spaceId: string;
  documentId: string;
  ydoc: Y.Doc;
  provider: WebsocketProvider;
  identity: { name: string; color: string };
  /** For @mention completion and for rendering a mention as a name. */
  members: Member[];
  currentUserId: string | undefined;
}) {
  const [editor, setEditor] = useState<TiptapEditor | null>(null);
  const [anchoredIds, setAnchoredIds] = useState<string[]>([]);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const { suggestions, requests, error, notice, setNotice, ask, resolve, dismissRequest } =
    useSuggestions(documentId, setFocusedId);

  const {
    threads,
    openThreads,
    error: commentsError,
    busy: commentsBusy,
    addThread,
    addReply,
    editComment,
    setResolved,
    removeComment,
  } = useComments(documentId);
  const [anchoredCommentIds, setAnchoredCommentIds] = useState<string[]>([]);
  const [focusedCommentId, setFocusedCommentId] = useState<string | null>(null);
  // The passage a new thread is being written about, held until the composer
  // is submitted. Null when nobody is composing.
  const [pendingComment, setPendingComment] = useState<PassageAnchor | null>(null);

  const accept = useCallback(
    async (s: Suggestion) => {
      // Decision first, text second. The API is what stops two collaborators
      // who click Accept together from both inserting the same text; only the
      // one whose decision was recorded goes on to apply it.
      if ((await resolve(s.id, true)) !== "ok" || !editor) return;
      const problem = applySuggestion(editor, s);
      if (problem) setNotice(problem);
    },
    [editor, resolve, setNotice]
  );

  const reject = useCallback((s: Suggestion) => void resolve(s.id, false), [resolve]);

  const {
    row: guideRow,
    guide,
    error: guideError,
    asking,
    running: guideRunning,
    workerSuspect,
    ask: askGuide,
  } = useStudyGuide(documentId);
  const [showGuide, setShowGuide] = useState(false);

  const requestGuide = useCallback(() => {
    if (!editor) return;
    // textBetween with a "\n\n" block separator, not getText(): the worker
    // splits the notes on blank lines to decide what to retrieve for, so the
    // block boundaries are the part that has to survive. Same call anchors.ts
    // uses to snapshot a passage.
    const notes = editor.state.doc.textBetween(
      0,
      editor.state.doc.content.size,
      "\n\n"
    );
    // Flipped only for a request that will actually be made. askGuide refuses
    // an empty document, and switching the view on the way in would render
    // whichever guide was generated last — so the click would look like it had
    // reopened an old guide rather than like it had been turned down.
    if (notes.trim() !== "") setShowGuide(true);
    void askGuide(notes);
  }, [editor, askGuide]);

  if (showGuide && guide) {
    return (
      <StudyGuideView
        guide={guide}
        generatedAt={guideRow?.finished_at ?? null}
        onClose={() => setShowGuide(false)}
      />
    );
  }

  return (
    <>
      <div className="workspace-toolbar">
        <button onClick={requestGuide} disabled={!editor || asking || guideRunning}>
          {guideRunning ? "Writing study guide…" : "Study guide"}
        </button>
        {guide && !guideRunning && (
          <button className="link-button" onClick={() => setShowGuide(true)}>
            Open the last guide
          </button>
        )}
        {/* Same reasoning as SourcesPanel's worker warning: the request
            succeeded, so nothing looks broken, and a stopped worker is the
            most common local-setup mistake. */}
        {workerSuspect && (
          <span className="muted">
            Still queued — is the agent worker running?
          </span>
        )}
        {guideError && <span className="error">{guideError}</span>}
      </div>

      <div className="app-layout">
        {/* One rail, two stacked panels: where you are in the notes, and what
            the agent may cite. Both are "about this document" navigation, and
            a fourth column would leave the editor too narrow to read. */}
        <div className="left-rail">
          <DocumentOutline editor={editor} />
          <SourcesPanel spaceId={spaceId} />
        </div>
        {/* Kept mounted and editable in every connection state. Yjs merges
            edits made while offline on reconnect — disabling the editor
            would trade away the "no lost edits" property for a worse
            experience. PresenceBar carries the status. */}
        <Editor
          ydoc={ydoc}
          provider={provider}
          user={identity}
          suggestions={suggestions}
          threads={openThreads}
          onAskAi={ask}
          onComment={setPendingComment}
          onSelectSuggestion={setFocusedId}
          onSelectComment={setFocusedCommentId}
          onAnchoredChange={setAnchoredIds}
          onAnchoredCommentsChange={setAnchoredCommentIds}
          onEditor={setEditor}
        />
        <SuggestionSidebar
          suggestions={suggestions}
          requests={requests}
          anchoredIds={anchoredIds}
          focusedId={focusedId}
          error={error}
          notice={notice}
          onAccept={(s) => void accept(s)}
          onReject={reject}
          onDismissRequest={dismissRequest}
          onFocus={setFocusedId}
        />
        <CommentsSidebar
          threads={threads}
          anchoredIds={anchoredCommentIds}
          focusedId={focusedCommentId}
          members={members}
          currentUserId={currentUserId}
          error={commentsError}
          busy={commentsBusy}
          onFocus={setFocusedCommentId}
          onReply={(id, body) => void addReply(id, body)}
          onEdit={(id, body) => void editComment(id, body)}
          onDelete={(id) => void removeComment(id)}
          onResolve={(id, resolved) => void setResolved(id, resolved)}
        />
      </div>

      {/* The composer for a new thread, over the page rather than in the
          rail: it belongs to the passage that is selected right now, and a
          box that appears 300px away from the highlighted text reads as
          unrelated to it. */}
      {pendingComment && (
        <div className="comment-draft-backdrop" onClick={() => setPendingComment(null)}>
          <div className="comment-draft" onClick={(e) => e.stopPropagation()}>
            <p className="comment-quote">“{pendingComment.quote}”</p>
            <CommentComposer
              members={members}
              placeholder="Ask your group about this passage…"
              submitLabel="Comment"
              autoFocus
              busy={commentsBusy}
              onSubmit={(body) => {
                void addThread(pendingComment, pendingComment.quote, body);
                setPendingComment(null);
              }}
              onCancel={() => setPendingComment(null)}
            />
          </div>
        </div>
      )}
    </>
  );
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
        ? { name: user.name || user.email || "Anonymous", color: colorFromUserId(user.id) }
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
        <ThemeToggle />
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
        <Workspace
          spaceId={spaceId}
          documentId={doc.id}
          ydoc={ydoc}
          provider={provider}
          identity={identity}
          members={members}
          currentUserId={user?.id}
        />
      ) : (
        <p className="muted">Connecting…</p>
      )}
    </div>
  );
}
