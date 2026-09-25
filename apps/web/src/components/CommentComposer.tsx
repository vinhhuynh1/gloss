/**
 * The box you type a comment into, with @mention completion.
 *
 * A plain <textarea>, not a second Tiptap editor. A comment is prose with no
 * formatting, and a second rich-text instance inside the sidebar of a
 * collaborative editor is a lot of machinery — plus its own plugins, its own
 * serialization — for text that ends up in a TEXT column either way.
 *
 * Mentions are completed to the member's **email**, because that is what the
 * API matches on (see MENTION_RE in routers/comments.py). Display names are
 * neither unique nor stable, so "@Khang" cannot identify anybody; the
 * rendered comment shows the name and hides the address (see CommentBody).
 */
import { useRef, useState } from "react";

import type { Member } from "../lib/types";

/** The "@partial" being typed immediately before the caret, or null. */
function mentionQuery(value: string, caret: number): { start: number; query: string } | null {
  const before = value.slice(0, caret);
  // Same rule as the slash menu: the trigger has to start a word, or every
  // email address typed into a comment opens a member picker.
  const match = /(?:^|\s)@([^@\s]*)$/.exec(before);
  if (!match) return null;
  return { start: caret - match[1].length - 1, query: match[1].toLowerCase() };
}

export default function CommentComposer({
  members,
  placeholder,
  submitLabel,
  autoFocus,
  initialValue,
  busy,
  onSubmit,
  onCancel,
}: {
  members: Member[];
  placeholder: string;
  submitLabel: string;
  autoFocus?: boolean;
  initialValue?: string;
  busy?: boolean;
  onSubmit: (body: string) => void;
  onCancel?: () => void;
}) {
  const [value, setValue] = useState(initialValue ?? "");
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [index, setIndex] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);

  const matches = mention
    ? members
        .filter(
          (m) =>
            m.name.toLowerCase().includes(mention.query) ||
            m.email.toLowerCase().includes(mention.query)
        )
        .slice(0, 6)
    : [];

  function sync(next: string, caret: number) {
    setValue(next);
    const found = mentionQuery(next, caret);
    setMention(found);
    if (found) setIndex(0);
  }

  function complete(member: Member) {
    if (!mention) return;
    const caret = ref.current?.selectionStart ?? value.length;
    const next =
      value.slice(0, mention.start) + `@${member.email} ` + value.slice(caret);
    setValue(next);
    setMention(null);
    // Put the caret after the inserted address rather than leaving it where
    // the partial was, which would drop the next keystroke into the middle of
    // the name that was just completed.
    const at = mention.start + member.email.length + 2;
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(at, at);
    });
  }

  function submit() {
    const body = value.trim();
    if (!body || busy) return;
    onSubmit(body);
    setValue("");
    setMention(null);
  }

  return (
    <div className="comment-composer">
      <textarea
        ref={ref}
        className="comment-input"
        rows={3}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => sync(e.target.value, e.target.selectionStart)}
        // Click and arrow keys move the caret without changing the value, and
        // the "@partial" under it changes with them.
        onSelect={(e) => {
          const el = e.target as HTMLTextAreaElement;
          sync(el.value, el.selectionStart);
        }}
        onKeyDown={(e) => {
          if (mention && matches.length > 0) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => (i + 1) % matches.length);
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => (i - 1 + matches.length) % matches.length);
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              complete(matches[index]);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setMention(null);
              return;
            }
          }
          // Enter submits, Shift+Enter is a newline — the convention in every
          // chat box, and a comment is usually one line.
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
          if (e.key === "Escape" && onCancel) onCancel();
        }}
      />

      {mention && matches.length > 0 && (
        <ul className="mention-menu" role="listbox" aria-label="Mention a member">
          {matches.map((m, i) => (
            <li key={m.user_id}>
              <button
                type="button"
                role="option"
                aria-selected={i === index}
                className={`mention-item${i === index ? " is-selected" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => complete(m)}
              >
                <span className="mention-name">{m.name}</span>
                <span className="mention-email">{m.email}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="comment-composer-actions">
        <button onClick={submit} disabled={busy || value.trim() === ""}>
          {submitLabel}
        </button>
        {onCancel && (
          <button className="link-button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
