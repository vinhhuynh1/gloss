/**
 * Headings in the current document, as a jump list.
 *
 * Derived from the editor state on every render rather than kept in state of
 * its own — the document is the single source of truth, which is the same
 * reason the editor takes no `content` prop. It does subscribe to the editor's
 * updates, though only to re-render: useEditor re-renders the Editor
 * component on each transaction, not the Workspace this panel sits in, so
 * without it the list went stale whenever a change arrived by some other
 * route than typing — notes inserted from the space chat, or a
 * collaborator's edit.
 *
 * Scrolling uses the ProseMirror DOM node for the heading rather than a
 * fragment id. Headings here have no ids — they are CRDT nodes, not anchors —
 * and inventing stable ones would mean writing them into the shared document,
 * where every collaborator would have to merge them.
 */
import type { Editor } from "@tiptap/react";
import { useEffect, useReducer } from "react";

import { headingEntries } from "../lib/sections";
import type { WeakSpot } from "../lib/types";

export default function DocumentOutline({
  editor,
  weakSpots = [],
}: {
  editor: Editor | null;
  weakSpots?: WeakSpot[];
}) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!editor) return;
    editor.on("update", rerender);
    return () => {
      editor.off("update", rerender);
    };
  }, [editor]);

  if (!editor) return null;
  const entries = headingEntries(editor.state.doc);
  // Lower-cased the way sections.ts keys them, so a weak spot recorded as
  // "Glycolysis" still marks a heading since retyped as "glycolysis".
  const weak = new Map(
    weakSpots.filter((w) => w.weak).map((w) => [w.section.toLowerCase(), w])
  );

  return (
    <nav className="outline-panel" aria-label="Document outline">
      <h2>Outline</h2>
      {entries.length === 0 ? (
        <p className="muted outline-empty">
          Headings you add show up here. Try <code>#</code> and a space, or the
          H1 button.
        </p>
      ) : (
        <ul className="outline-list">
          {entries.map((e) => {
            const spot = weak.get(e.text.toLowerCase());
            return (
              <li key={e.pos}>
                <button
                  className={`outline-item outline-level-${Math.min(e.level, 3)}`}
                  title={e.text}
                  onClick={() => {
                    // Put the caret in the heading first: that is what makes
                    // typing continue from where the reader just jumped to,
                    // rather than wherever they were before.
                    editor.chain().focus().setTextSelection(e.pos + 1).run();
                    const dom = editor.view.domAtPos(e.pos + 1).node;
                    const el =
                      dom instanceof HTMLElement ? dom : dom.parentElement;
                    el?.scrollIntoView({ block: "center", behavior: "smooth" });
                  }}
                >
                  {e.text}
                  {spot && (
                    <span
                      className="outline-weak"
                      aria-label={`, ${spot.correct} of ${spot.asked} right in your quizzes`}
                    >
                      {spot.correct}/{spot.asked}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}
