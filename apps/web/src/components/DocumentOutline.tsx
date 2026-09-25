/**
 * Headings in the current document, as a jump list.
 *
 * Derived from the editor state on every render rather than kept in state of
 * its own: useEditor re-renders on each transaction, so this list is correct
 * after a local edit *and* after a collaborator's, with no subscription to
 * keep in sync. The document is the single source of truth, which is the same
 * reason the editor takes no `content` prop.
 *
 * Scrolling uses the ProseMirror DOM node for the heading rather than a
 * fragment id. Headings here have no ids — they are CRDT nodes, not anchors —
 * and inventing stable ones would mean writing them into the shared document,
 * where every collaborator would have to merge them.
 */
import type { Editor } from "@tiptap/react";

interface Entry {
  /** ProseMirror document position, which is also a stable React key within
   * one render pass. */
  pos: number;
  level: number;
  text: string;
}

function headings(editor: Editor): Entry[] {
  const found: Entry[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== "heading") return;
    const text = node.textContent.trim();
    // An empty heading is someone mid-thought on a fresh line. It would be a
    // blank row that scrolls somewhere unexplained.
    if (text) found.push({ pos, level: node.attrs.level as number, text });
  });
  return found;
}

export default function DocumentOutline({ editor }: { editor: Editor | null }) {
  if (!editor) return null;
  const entries = headings(editor);

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
          {entries.map((e) => (
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
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
