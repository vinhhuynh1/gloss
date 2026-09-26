/**
 * Who can see this space, and how to add someone.
 *
 * Replaces a bar that slid out under the header with one field in it. That bar
 * could add a person but never answered the question people actually open a
 * share control to ask — who is already in here? The member count was in the
 * header, three words away from a form that couldn't show you the names behind
 * it.
 *
 * The invite is deliberately not a "send". This API resolves an address to an
 * existing account and adds them; nothing is emailed, and an address with no
 * account is an error rather than a pending invitation. Saying so next to the
 * field is the difference between "it's not working" and "they need to sign up
 * first".
 */
import { useId, useRef, useState } from "react";

import type { Member } from "../lib/types";
import { colorFromUserId } from "../lib/avatarColor";
import Modal from "./Modal";
import { IconDismiss, IconInvite } from "./Icon";

/** Owner first, then alphabetical. The API returns join order, which puts the
 * newest person in the middle of the list and is no help to anyone. */
function ordered(members: Member[]): Member[] {
  return [...members].sort((a, b) => {
    if (a.role !== b.role) return a.role === "owner" ? -1 : 1;
    return (a.name || a.email).localeCompare(b.name || b.email);
  });
}

export default function ShareDialog({
  spaceName,
  members,
  currentUserId,
  onInvite,
  onClose,
}: {
  spaceName: string;
  members: Member[];
  currentUserId: string | undefined;
  /** Throws on failure; the message is shown against the field rather than in
   * the page's error banner, which is behind this dialog. */
  onInvite: (email: string) => Promise<void>;
  onClose: () => void;
}) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const hintId = useId();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const address = email.trim();
    if (!address || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onInvite(address);
      setEmail("");
      // Focus stays in the field: adding several people in a row is the
      // normal case, and hunting for the input again each time is not.
      inputRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add them");
    } finally {
      setBusy(false);
    }
  }

  const rows = ordered(members);

  return (
    <Modal
      className="share-card"
      labelledBy={titleId}
      initialFocusRef={inputRef}
      onClose={onClose}
    >
      <div className="share-head">
        <h2 className="share-title" id={titleId}>
          Invite to “{spaceName}”
        </h2>
        <button
          type="button"
          className="icon-button is-small"
          onClick={onClose}
          aria-label="Close"
        >
          <IconDismiss size={14} />
        </button>
      </div>

      <form className="share-invite" onSubmit={submit}>
        <div className="share-field">
          <input
            ref={inputRef}
            type="email"
            value={email}
            disabled={busy}
            aria-describedby={hintId}
            aria-invalid={error ? true : undefined}
            onChange={(e) => {
              setEmail(e.target.value);
              if (error) setError(null);
            }}
            placeholder="Classmate's email address"
          />
          <button type="submit" className="with-icon" disabled={busy || !email.trim()}>
            <IconInvite size={14} />
            {busy ? "Adding…" : "Add"}
          </button>
        </div>
        {error ? (
          <p className="share-error" role="alert">
            {error}
          </p>
        ) : (
          <p className="share-hint" id={hintId}>
            They need an account already — this resolves an address to a person
            rather than sending mail.
          </p>
        )}
      </form>

      <div className="share-people">
        <h3 className="share-people-head">
          People with access
          <span className="panel-count">{members.length}</span>
        </h3>
        <ul className="share-list">
          {rows.map((m) => (
            <li className="share-person" key={m.user_id}>
              <span
                className="share-avatar"
                style={{ backgroundColor: colorFromUserId(m.user_id) }}
                aria-hidden="true"
              >
                {(m.name || m.email).slice(0, 1).toUpperCase()}
              </span>
              <span className="share-person-text">
                <span className="share-person-name">
                  {m.name || m.email}
                  {m.user_id === currentUserId && (
                    <span className="share-you"> (you)</span>
                  )}
                </span>
                <span className="share-person-email">{m.email}</span>
              </span>
              <span
                className={`share-role${m.role === "owner" ? " is-owner" : ""}`}
              >
                {m.role === "owner" ? "Owner" : "Member"}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="share-actions">
        <button type="button" className="confirm-cancel" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}
