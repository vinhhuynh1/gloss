/**
 * Everything said about the notes, in the order it was said about them.
 *
 * This replaces the two rails that used to sit side by side — one for the
 * agent, one for the group. Splitting them by *who was speaking* meant a
 * reader had to know which panel a remark was in before they could find it,
 * and it cost 640px of chrome on a 1440px screen to say so.
 *
 * A margin sorts by position, not by speaker. A suggestion about paragraph
 * two and a classmate's question about paragraph two belong next to each
 * other, because they are about the same sentence. The ordering is computed
 * in Editor.tsx, where the ProseMirror state lives; this is a renderer.
 *
 * Colour carries the distinction the layout no longer does: flare is the
 * agent, deep is people. See the palette note in styles.css.
 */
import { useEffect, useRef, useState } from "react";

import CommentComposer from "./CommentComposer";
import type {
  AnchoredAnnotation,
  Comment,
  CommentThread,
  Member,
  Suggestion,
} from "../lib/types";
import { type TrackedRequest, WORKER_SUSPECT_MS } from "../lib/useSuggestions";

const TYPE_LABELS: Record<Suggestion["type"], string> = {
  citation: "Citation",
  contradiction: "Contradiction",
  gap_fill: "Gap",
};

/** A check that has been asked for but has no answer yet, so no position
 * either. These sit above the ordered stream rather than inside it. */
function RequestChip({
  request,
  onDismiss,
}: {
  request: TrackedRequest;
  onDismiss: () => void;
}) {
  const preview =
    request.passage.length > 60 ? `${request.passage.slice(0, 60)}…` : request.passage;

  if (request.status === "failed") {
    return (
      <div className="request-chip request-failed">
        <span>Check failed: {request.error ?? "unknown error"}</span>
        <button className="link-button" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    );
  }
  if (request.status === "done") {
    return <div className="request-chip request-clear">No issues found in “{preview}”</div>;
  }

  const stalled =
    request.status === "pending" && Date.now() - request.askedAt > WORKER_SUSPECT_MS;
  return (
    <div className="request-chip request-open">
      <span>Checking “{preview}”…</span>
      {stalled && (
        <p className="warning">
          Still waiting. A check waits for this space&apos;s uploads to finish
          processing — otherwise, is the agent worker running?
          <code>cd apps/agent-worker &amp;&amp; python worker.py</code>
        </p>
      )}
    </div>
  );
}

/** Renders @addresses as the member's display name. The body stores the
 * address because that is what the API resolves against; the pattern here is
 * kept in step with MENTION_RE in routers/comments.py. */
function CommentBody({ body, members }: { body: string; members: Member[] }) {
  const byEmail = new Map(members.map((m) => [m.email.toLowerCase(), m]));
  const parts = body.split(/(@[^@\s]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)/g);
  return (
    <p className="comment-body">
      {parts.map((part, i) => {
        if (!part.startsWith("@")) return <span key={i}>{part}</span>;
        const member = byEmail.get(part.slice(1).toLowerCase());
        if (!member) return <span key={i}>{part}</span>;
        return (
          <span key={i} className="mention" title={member.email}>
            @{member.name}
          </span>
        );
      })}
    </p>
  );
}

function when(iso: string): string {
  const d = new Date(iso + (iso.endsWith("Z") ? "" : "Z"));
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function CommentRow({
  comment,
  members,
  currentUserId,
  busy,
  onEdit,
  onDelete,
}: {
  comment: Comment;
  members: Member[];
  currentUserId: string | undefined;
  busy: boolean;
  onEdit: (id: string, body: string) => void;
  onDelete: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const mine = comment.author_id === currentUserId;

  if (editing) {
    return (
      <div className="comment-row">
        <CommentComposer
          members={members}
          placeholder="Edit your comment"
          submitLabel="Save"
          autoFocus
          initialValue={comment.body}
          busy={busy}
          onSubmit={(body) => {
            onEdit(comment.id, body);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  return (
    <div className="comment-row">
      <div className="comment-meta">
        <span className="comment-author">{comment.author_name}</span>
        <span className="comment-time">
          {when(comment.created_at)}
          {comment.edited_at && " · edited"}
        </span>
      </div>
      <CommentBody body={comment.body} members={members} />
      {mine && (
        <div className="comment-row-actions">
          <button className="link-button" onClick={() => setEditing(true)}>
            Edit
          </button>
          <button className="link-button" onClick={() => onDelete(comment.id)}>
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

export interface AnnotationMarginProps {
  /** Ordered by position in the document; anything absent is detached. */
  annotations: AnchoredAnnotation[];
  suggestions: Suggestion[];
  threads: CommentThread[];
  requests: TrackedRequest[];
  focusedId: string | null;
  members: Member[];
  currentUserId: string | undefined;
  error: string | null;
  commentsError: string | null;
  notice: string | null;
  busy: boolean;
  onFocus: (id: string | null) => void;
  onAccept: (s: Suggestion) => void;
  onReject: (s: Suggestion) => void;
  onDismissRequest: (id: string) => void;
  onReply: (rootId: string, body: string) => void;
  onEditComment: (id: string, body: string) => void;
  onDeleteComment: (id: string) => void;
  onResolve: (id: string, resolved: boolean) => void;
}

export default function AnnotationMargin({
  annotations,
  suggestions,
  threads,
  requests,
  focusedId,
  members,
  currentUserId,
  error,
  commentsError,
  notice,
  busy,
  onFocus,
  onAccept,
  onReject,
  onDismissRequest,
  onReply,
  onEditComment,
  onDeleteComment,
  onResolve,
}: AnnotationMarginProps) {
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);

  // Clicking a highlight, or a check coming back, focuses a card; bring it
  // into view, since the stream can be longer than the margin.
  useEffect(() => {
    if (focusedId) {
      cardRefs.current
        .get(focusedId)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [focusedId]);

  const suggestionById = new Map(suggestions.map((s) => [s.id, s]));
  const threadById = new Map(threads.map((t) => [t.root.id, t]));
  const placed = new Set(annotations.map((a) => a.id));

  // The ordered stream first, then everything that has lost its passage. A
  // detached item cannot be ordered by position because it no longer has one,
  // and dropping it would silently discard someone's writing.
  const ordered: AnchoredAnnotation[] = [
    ...annotations,
    ...suggestions
      .filter((s) => !placed.has(s.id))
      .map((s) => ({ kind: "suggestion" as const, id: s.id, from: Infinity })),
    ...threads
      .filter((t) => !placed.has(t.root.id) && t.root.resolved_at === null)
      .map((t) => ({ kind: "comment" as const, id: t.root.id, from: Infinity })),
  ];

  const resolved = threads.filter((t) => t.root.resolved_at !== null);
  const shown = showResolved
    ? [
        ...ordered,
        ...resolved.map((t) => ({
          kind: "comment" as const,
          id: t.root.id,
          from: Infinity,
        })),
      ]
    : ordered;

  const setRef = (id: string) => (el: HTMLDivElement | null) => {
    if (el) cardRefs.current.set(id, el);
    else cardRefs.current.delete(id);
  };

  return (
    <aside className="annotation-margin" aria-label="Annotations">
      <h2 className="margin-heading">Margin</h2>

      {error && <p className="error">{error}</p>}
      {commentsError && <p className="error">{commentsError}</p>}
      {notice && <p className="warning">{notice}</p>}

      {requests.map((r) => (
        <RequestChip key={r.id} request={r} onDismiss={() => onDismissRequest(r.id)} />
      ))}

      {shown.length === 0 && requests.length === 0 && (
        <p className="muted margin-empty">
          Select a passage to check it against your sources, or to ask your
          group about it. Whatever anyone says about the notes shows up here,
          in the order it appears in the text.
        </p>
      )}

      {resolved.length > 0 && (
        <label className="comment-filter">
          <input
            type="checkbox"
            checked={showResolved}
            onChange={(e) => setShowResolved(e.target.checked)}
          />
          Show {resolved.length} resolved
        </label>
      )}

      <ol className="annotation-stream">
        {shown.map((a, i) => {
          const detached = a.from === Infinity;
          const index = i + 1;

          if (a.kind === "suggestion") {
            const s = suggestionById.get(a.id);
            if (!s) return null;
            // A suggestion from the agent CLI never had a position; one whose
            // passage was deleted has lost it. Either way there is nowhere to
            // put the text, so it can only be dismissed.
            const unplaceable = !s.anchor.from
              ? "Made outside the editor, so it has no place in the notes."
              : "The passage this was about has been deleted.";
            return (
              <li key={`s-${s.id}`}>
                <div
                  ref={setRef(s.id)}
                  className={`annotation is-agent annotation-${s.type}${
                    focusedId === s.id ? " is-focused" : ""
                  }${detached ? " is-detached" : ""}`}
                  onMouseEnter={() => onFocus(s.id)}
                >
                  <div className="annotation-head">
                    <span className="annotation-index">{index}</span>
                    <span className="annotation-kind">{TYPE_LABELS[s.type]}</span>
                  </div>
                  {s.anchor.quote && (
                    <blockquote className="annotation-quote">{s.anchor.quote}</blockquote>
                  )}
                  <p className="annotation-body">{s.proposed_text}</p>

                  {(s.source_filename || s.source_excerpt) && (
                    <details className="annotation-source">
                      <summary className="mono">
                        {[s.source_filename, s.source_page_ref]
                          .filter(Boolean)
                          .join(", ") || "course material"}
                      </summary>
                      {s.source_excerpt && <p>{s.source_excerpt}</p>}
                    </details>
                  )}

                  {detached && <p className="muted annotation-note">{unplaceable}</p>}

                  <div className="annotation-actions">
                    {!detached ? (
                      <>
                        <button onClick={() => onAccept(s)}>Accept</button>
                        <button className="ghost" onClick={() => onReject(s)}>
                          Reject
                        </button>
                      </>
                    ) : (
                      <button className="ghost" onClick={() => onReject(s)}>
                        Dismiss
                      </button>
                    )}
                  </div>
                </div>
              </li>
            );
          }

          const thread = threadById.get(a.id);
          if (!thread) return null;
          const isResolved = thread.root.resolved_at !== null;
          return (
            <li key={`c-${thread.root.id}`}>
              <div
                ref={setRef(thread.root.id)}
                className={`annotation is-human${
                  focusedId === thread.root.id ? " is-focused" : ""
                }${isResolved ? " is-resolved" : ""}${
                  detached && !isResolved ? " is-detached" : ""
                }`}
                onClick={() => onFocus(thread.root.id)}
              >
                <div className="annotation-head">
                  <span className="annotation-index">{index}</span>
                  <span className="annotation-kind">
                    {isResolved ? "Resolved" : "Thread"}
                  </span>
                </div>

                {thread.root.quote && (
                  <blockquote className="annotation-quote">{thread.root.quote}</blockquote>
                )}
                {detached && !isResolved && (
                  <p className="muted annotation-note">
                    The passage this was about has been deleted.
                  </p>
                )}

                <CommentRow
                  comment={thread.root}
                  members={members}
                  currentUserId={currentUserId}
                  busy={busy}
                  onEdit={onEditComment}
                  onDelete={onDeleteComment}
                />

                {thread.replies.map((reply) => (
                  <div className="comment-reply" key={reply.id}>
                    <CommentRow
                      comment={reply}
                      members={members}
                      currentUserId={currentUserId}
                      busy={busy}
                      onEdit={onEditComment}
                      onDelete={onDeleteComment}
                    />
                  </div>
                ))}

                <div className="annotation-actions">
                  {replyingTo === thread.root.id ? (
                    <CommentComposer
                      members={members}
                      placeholder="Reply…"
                      submitLabel="Reply"
                      autoFocus
                      busy={busy}
                      onSubmit={(body) => {
                        onReply(thread.root.id, body);
                        setReplyingTo(null);
                      }}
                      onCancel={() => setReplyingTo(null)}
                    />
                  ) : (
                    <>
                      <button
                        className="ghost"
                        onClick={() => setReplyingTo(thread.root.id)}
                      >
                        Reply
                      </button>
                      <button
                        className="ghost"
                        onClick={() => onResolve(thread.root.id, !isResolved)}
                      >
                        {isResolved ? "Reopen" : "Resolve"}
                      </button>
                    </>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
