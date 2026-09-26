/**
 * The formatting toolbar.
 *
 * Every command here already existed — StarterKit ships the marks and nodes
 * and binds the usual keyboard shortcuts and markdown input rules. Nothing
 * surfaced them, so the whole feature set was discoverable only by already
 * knowing it was there, which is no use to someone typing notes in a lecture.
 *
 * Icons, not glyphs. This bar used to read `<>` `{ }` `•` `1.` `❝` `↶` `↷` —
 * ASCII approximations of icons, at whatever width the font happened to give
 * them, which is the single clearest sign of an interface nobody drew. Every
 * control is now icon-only with its name on aria-label and in the tooltip.
 *
 * Undo and redo come from @tiptap/extension-collaboration, not StarterKit:
 * StarterKit's history is switched off in Editor.tsx because a CRDT needs an
 * undo stack that only rolls back *your* edits — a plain history would
 * happily undo a collaborator's paragraph. The Collaboration extension swaps
 * in a Y.UndoManager-backed pair under the same command names.
 */
import type { Editor } from "@tiptap/react";

import {
  IconBold,
  IconBulletList,
  IconCode,
  IconCodeBlock,
  IconH1,
  IconH2,
  IconH3,
  IconItalic,
  IconOrderedList,
  IconQuote,
  IconRedo,
  IconStrike,
  IconUndo,
  type IconProps,
} from "./Icon";

interface Item {
  /** Names the control for screen readers and the tooltip. There is no
   * visible label, so this is the only name it has. */
  title: string;
  Icon: (props: IconProps) => JSX.Element;
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
        title: "Bold (Ctrl+B)",
        Icon: IconBold,
        active: () => editor.isActive("bold"),
        run: () => editor.chain().focus().toggleBold().run(),
      },
      {
        title: "Italic (Ctrl+I)",
        Icon: IconItalic,
        active: () => editor.isActive("italic"),
        run: () => editor.chain().focus().toggleItalic().run(),
      },
      {
        title: "Strikethrough",
        Icon: IconStrike,
        active: () => editor.isActive("strike"),
        run: () => editor.chain().focus().toggleStrike().run(),
      },
      {
        title: "Inline code",
        Icon: IconCode,
        active: () => editor.isActive("code"),
        run: () => editor.chain().focus().toggleCode().run(),
      },
    ],
    [
      { level: 1 as const, Icon: IconH1 },
      { level: 2 as const, Icon: IconH2 },
      { level: 3 as const, Icon: IconH3 },
    ].map(({ level, Icon }) => ({
      title: `Heading ${level}`,
      Icon,
      active: () => editor.isActive("heading", { level }),
      run: () => editor.chain().focus().toggleHeading({ level }).run(),
    })),
    [
      {
        title: "Bulleted list",
        Icon: IconBulletList,
        active: () => editor.isActive("bulletList"),
        run: () => editor.chain().focus().toggleBulletList().run(),
      },
      {
        title: "Numbered list",
        Icon: IconOrderedList,
        active: () => editor.isActive("orderedList"),
        run: () => editor.chain().focus().toggleOrderedList().run(),
      },
      {
        title: "Quote",
        Icon: IconQuote,
        active: () => editor.isActive("blockquote"),
        run: () => editor.chain().focus().toggleBlockquote().run(),
      },
      {
        title: "Code block",
        Icon: IconCodeBlock,
        active: () => editor.isActive("codeBlock"),
        run: () => editor.chain().focus().toggleCodeBlock().run(),
      },
    ],
    [
      {
        title: "Undo (Ctrl+Z) — your own edits only",
        Icon: IconUndo,
        run: () => editor.chain().focus().undo().run(),
        enabled: () => editor.can().undo(),
      },
      {
        title: "Redo (Ctrl+Shift+Z)",
        Icon: IconRedo,
        run: () => editor.chain().focus().redo().run(),
        enabled: () => editor.can().redo(),
      },
    ],
  ];

  return (
    <div className="editor-toolbar" role="toolbar" aria-label="Formatting">
      {groups.map((group, i) => (
        <div className="editor-toolbar-group" key={i}>
          {group.map(({ title, Icon, active, run, enabled }) => {
            const on = active?.() ?? false;
            return (
              <button
                key={title}
                type="button"
                className={`toolbar-button${on ? " is-active" : ""}`}
                title={title}
                aria-label={title}
                aria-pressed={active ? on : undefined}
                disabled={enabled ? !enabled() : false}
                // The editor blurs when a toolbar button takes focus, and a
                // blurred editor has no selection to format. Preventing the
                // default on mousedown keeps the caret where it was; .focus()
                // in each command then puts focus back.
                onMouseDown={(e) => e.preventDefault()}
                onClick={run}
              >
                <Icon size={18} />
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
