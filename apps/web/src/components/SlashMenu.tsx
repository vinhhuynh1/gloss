/**
 * The popup for the "/" menu. All state lives in the plugin
 * (extensions/SlashMenu.ts); this only draws it and handles the mouse.
 *
 * Positioned from coordsAtPos rather than rendered inline in the document:
 * an inline node would be content, and content in a CRDT is content every
 * collaborator receives. Same reasoning as the decorations in
 * SuggestionHighlights.ts.
 *
 * Rendered through a portal, which is not cosmetic. BubbleMenu is tippy.js
 * underneath and moves its own element out to document.body while React still
 * believes it sits in the editor pane. A sibling that mounts and unmounts next
 * to it — which is exactly what this popup does — made React try to remove a
 * node tippy had already moved, and the whole editor came down with
 * "NotFoundError: The node to be removed is not a child of this node". The
 * popup is position: fixed, so leaving the pane costs nothing.
 */
import type { Editor } from "@tiptap/react";
import { createPortal } from "react-dom";

import { slashMenuKey } from "../extensions/SlashMenu";

export default function SlashMenu({ editor }: { editor: Editor | null }) {
  if (!editor) return null;

  const state = slashMenuKey.getState(editor.state);
  if (!state) return null;

  // The caret's viewport coordinates. `position: fixed` then needs no scroll
  // maths — the popup is re-rendered on the next transaction anyway, and a
  // scroll that moves the caret produces one.
  const coords = editor.view.coordsAtPos(state.range.from);

  return createPortal(
    <div
      className="slash-menu"
      style={{ top: `${coords.bottom + 6}px`, left: `${coords.left}px` }}
      role="listbox"
      aria-label="Insert block"
    >
      {state.items.map((item, i) => (
        <button
          key={item.title}
          type="button"
          role="option"
          aria-selected={i === state.index}
          className={`slash-item${i === state.index ? " is-selected" : ""}`}
          // Same reason as the toolbar: a blurred editor has no caret to
          // replace, and mousedown is what blurs it.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => item.run(editor, state.range)}
        >
          <span className="slash-title">{item.title}</span>
          <span className="slash-hint">{item.hint}</span>
        </button>
      ))}
    </div>,
    document.body
  );
}
