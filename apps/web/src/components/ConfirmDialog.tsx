/**
 * The confirmation for an action that cannot be undone.
 *
 * Replaces window.confirm, which was doing this job in two places. The native
 * dialog is quick to write and wrong in every other way: it renders in the
 * browser's chrome rather than the app's, so it ignores the theme entirely and
 * arrives as a white box in a dark window; it cannot say which button is the
 * destructive one, because both are OS-styled; its wording is prefixed with
 * the origin; and on some platforms it offers a "don't show me these again"
 * checkbox that silently disables every confirmation the page has.
 *
 * Cancel is first in the DOM, so Modal's default focus lands there rather than
 * on the destructive button — a dialog that opens with "Delete" focused turns
 * a stray Enter, very likely since Enter is often what opened the menu, into
 * the deletion it was meant to prevent.
 */
import { useId } from "react";

import Modal from "./Modal";
import { IconWarn } from "./Icon";

export default function ConfirmDialog({
  title,
  body,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
}: {
  title: string;
  /** What is actually lost. Specific beats "Are you sure?". */
  body: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const bodyId = useId();

  return (
    <Modal
      role="alertdialog"
      className="confirm-card"
      labelledBy={titleId}
      describedBy={bodyId}
      onClose={onCancel}
    >
      <span className="confirm-mark" aria-hidden="true">
        <IconWarn size={18} />
      </span>
      <h2 className="confirm-title" id={titleId}>
        {title}
      </h2>
      <p className="confirm-body" id={bodyId}>
        {body}
      </p>
      <div className="confirm-actions">
        <button type="button" className="confirm-cancel" onClick={onCancel}>
          {cancelLabel}
        </button>
        <button type="button" className="confirm-go" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
