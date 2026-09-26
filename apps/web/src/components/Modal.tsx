/**
 * The shell every dialog in the app shares: a portal, a backdrop, and the
 * three keyboard behaviours a modal has to get right.
 *
 * Extracted rather than copied. The confirmation and the share sheet look
 * nothing alike, but the parts that are easy to get wrong — capturing Escape
 * before the editor sees it, keeping Tab inside, putting focus back where it
 * came from — are identical, and two copies of them drift.
 */
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function Modal({
  role = "dialog",
  labelledBy,
  describedBy,
  className = "",
  /** Where focus lands on open. Defaults to the first focusable thing, which
   * is right for a confirmation but not for a sheet whose first control is a
   * close button. */
  initialFocusRef,
  onClose,
  children,
}: {
  role?: "dialog" | "alertdialog";
  labelledBy?: string;
  describedBy?: string;
  className?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
}) {
  const cardRef = useRef<HTMLDivElement>(null);

  // Focus moves in, and goes back where it came from on close — otherwise it
  // lands on <body> and the next Tab starts from the top of the page.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const target =
      initialFocusRef?.current ??
      cardRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus();
    return () => opener?.focus?.();
    // Deliberately once, on mount: re-running would steal focus back from
    // wherever the person has since moved it inside the dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        // Capture phase and stopPropagation: the row menu and the editor both
        // listen for Escape, and without this one key closes the dialog and
        // something underneath it at the same time.
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !cardRef.current) return;
      // Recomputed per keypress rather than cached: the share sheet's list
      // grows as people are invited.
      const items = [...cardRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return createPortal(
    <div
      className="modal-backdrop"
      // mousedown, not click: a drag that starts inside the card and releases
      // on the backdrop would otherwise dismiss it.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={cardRef}
        className={`modal-card ${className}`.trim()}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}
