/**
 * The formatting toolbar.
 *
 * Every command here already existed — StarterKit ships the marks and nodes
 * and binds the usual keyboard shortcuts and markdown input rules. Nothing
 * surfaced them, so the whole feature set was discoverable only by already
 * knowing it was there, which is no use to someone who types notes in a
 * lecture.
 *
 * Undo and redo come from @tiptap/extension-collaboration, not StarterKit:
 * StarterKit's history is switched off in Editor.tsx because a CRDT needs an
 * undo stack that only rolls back *your* edits — a plain history would
 * happily undo a collaborator's paragraph. The Collaboration extension swaps
 * in a Y.UndoManager-backed pair under the same command names.
 */
import type { Editor } from "@tiptap/react";

/** A group of buttons with a divider after it. */
interface Item {
  label: string;
  title: string;
  /** Marks the button as on. Omitted for commands with no state, like undo. */
  active?: () => boolean;
  run: () => void;
  enabled?: () => boolean;
}

export default function EditorToolbar({ editor }: { editor: Editor | null }) {
  if (!editor) return null;

  // Rebuilt every render on purpose: useEditor re-renders its component on
  // each transaction, so these closures always read current state and the
  // pressed states stay in step with the caret.
  const groups: Item[][] = [
    [
      {
        label: "B",
        title: "Bold (Ctrl+B)",
        active: () => editor.isActive("bold"),
        run: () => editor.chain().focus().toggleBold().run(),
      },
      {
        label: "I",
        title: "Italic (Ctrl+I)",
        active: () => editor.isActive("italic"),
        run: () => editor.chain().focus().toggleItalic().run(),
      },
      {
        label: "S",
        title: "Strikethrough",
        active: () => editor.isActive("strike"),
        run: () => editor.chain().focus().toggleStrike().run(),
      },
      {
        label: "<>",
        title: "Inline code",
        active: () => editor.isActive("code"),
        run: () => editor.chain().focus().toggleCode().run(),
      },
    ],
    [1, 2, 3].map((level) => ({
      label: `H${level}`,
      title: `Heading ${level}`,
      active: () => editor.isActive("heading", { level }),
      run: () =>
        editor
          .chain()
          .focus()
          .toggleHeading({ level: level as 1 | 2 | 3 })
          .run(),
    })),
    [
      {
        label: "•",
        title: "Bulleted list",
        active: () => editor.isActive("bulletList"),
        run: () => editor.chain().focus().toggleBulletList().run(),
      },
      {
        label: "1.",
        title: "Numbered list",
        active: () => editor.isActive("orderedList"),
        run: () => editor.chain().focus().toggleOrderedList().run(),
      },
      {
        label: "❝",
        title: "Quote",
        active: () => editor.isActive("blockquote"),
        run: () => editor.chain().focus().toggleBlockquote().run(),
      },
      {
        label: "{ }",
        title: "Code block",
        active: () => editor.isActive("codeBlock"),
        run: () => editor.chain().focus().toggleCodeBlock().run(),
      },
    ],
    [
      {
        label: "↶",
        title: "Undo (Ctrl+Z) — your own edits only",
        run: () => editor.chain().focus().undo().run(),
        enabled: () => editor.can().undo(),
      },
      {
        label: "↷",
        title: "Redo (Ctrl+Shift+Z)",
        run: () => editor.chain().focus().redo().run(),
        enabled: () => editor.can().redo(),
      },
    ],
  ];

  return (
    <div className="editor-toolbar" role="toolbar" aria-label="Formatting">
      {groups.map((group, i) => (
        <div className="editor-toolbar-group" key={i}>
          {group.map((item) => {
            const on = item.active?.() ?? false;
            return (
              <button
                key={item.label}
                type="button"
                className={`toolbar-button${on ? " is-active" : ""}`}
                title={item.title}
                aria-label={item.title}
                aria-pressed={item.active ? on : undefined}
                disabled={item.enabled ? !item.enabled() : false}
                // The editor blurs when a toolbar button takes focus, and a
                // blurred editor has no selection to format. Preventing the
                // default on mousedown keeps the caret where it was; .focus()
                // in each command then puts focus back.
                onMouseDown={(e) => e.preventDefault()}
                onClick={item.run}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
