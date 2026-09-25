/**
 * Comment threads for the open document.
 *
 * A separate rail from SuggestionSidebar, sharing its chrome. The two lists
 * answer different questions — what the agent proposes, and what your group
 * is asking each other — and interleaving them would mean an accept/reject
 * card and a conversation competing for the same column.
 *
 * A thread whose passage has been deleted is shown as detached rather than
 * hidden: someone wrote it, it still has replies, and the quote snapshot
 * (006_comments.sql) is exactly what lets it say what it used to be about.
 */
import { useState } from "react";

import CommentComposer from "./CommentComposer";
import type { Comment, CommentThread, Member } from "../lib/types";

/** Renders @addresses as the member's display name.
 *
 * The body stores the address because that is what the API resolves against,
 * but "@vinhhuynh173@gmail.com" in the middle of a sentence is unreadable.
 * An address that matches no member is left as written — it is just text. */
function CommentBody({ body, members }: { body: string; members: Member[] }) {
  const byEmail = new Map(members.map((m) => [m.email.toLowerCase(), m]));
  // Same pattern as MENTION_RE in routers/comments.py. Kept in step with it
  // deliberately: a mention this renders but the API did not record would be
  // highlighted for a person who was never actually mentioned.
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

export default function CommentsSidebar({
  threads,
  anchoredIds,
  focusedId,
  members,
  currentUserId,
  error,
  busy,
  onFocus,
  onReply,
  onEdit,
  onDelete,
  onResolve,
}: {
  threads: CommentThread[];
  /** Thread ids that still have a highlight in the document. */
  anchoredIds: string[];
  focusedId: string | null;
  members: Member[];
  currentUserId: string | undefined;
  error: string | null;
  busy: boolean;
  onFocus: (id: string | null) => void;
  onReply: (rootId: string, body: string) => void;
  onEdit: (id: string, body: string) => void;
  onDelete: (id: string) => void;
  onResolve: (id: string, resolved: boolean) => void;
}) {
  const [showResolved, setShowResolved] = useState(false);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);

  const anchored = new Set(anchoredIds);
  const open = threads.filter((t) => t.root.resolved_at === null);
  const resolved = threads.filter((t) => t.root.resolved_at !== null);
  const shown = showResolved ? threads : open;

  return (
    <aside className="comments-sidebar">
      <h2>Comments</h2>
      {error && <p className="error">{error}</p>}

      {threads.length === 0 && (
        <p className="muted">
          Select text in the notes and choose “Comment” to start a thread.
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

      {shown.map((thread) => {
        const isResolved = thread.root.resolved_at !== null;
        const detached = !isResolved && !anchored.has(thread.root.id);
        return (
          <div
            key={thread.root.id}
            className={[
              "comment-thread",
              focusedId === thread.root.id ? "comment-focused" : "",
              isResolved ? "comment-resolved" : "",
              detached ? "comment-detached" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            onClick={() => onFocus(thread.root.id)}
          >
            {thread.root.quote && (
              <p className="comment-quote">“{thread.root.quote}”</p>
            )}
            {detached && (
              <p className="muted comment-detached-note">
                The passage this was about has been deleted.
              </p>
            )}

            <CommentRow
              comment={thread.root}
              members={members}
              currentUserId={currentUserId}
              busy={busy}
              onEdit={onEdit}
              onDelete={onDelete}
            />

            {thread.replies.map((reply) => (
              <div className="comment-reply" key={reply.id}>
                <CommentRow
                  comment={reply}
                  members={members}
                  currentUserId={currentUserId}
                  busy={busy}
                  onEdit={onEdit}
                  onDelete={onDelete}
                />
              </div>
            ))}

            <div className="comment-thread-actions">
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
                    className="link-button"
                    onClick={() => setReplyingTo(thread.root.id)}
                  >
                    Reply
                  </button>
                  <button
                    className="link-button"
                    onClick={() => onResolve(thread.root.id, !isResolved)}
                  >
                    {isResolved ? "Reopen" : "Resolve"}
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </aside>
  );
}
