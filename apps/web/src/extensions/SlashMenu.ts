/**
 * The "/" block menu.
 *
 * A ProseMirror plugin rather than @tiptap/suggestion: that package arrives
 * here only as a transitive dependency of extensions this app does not use,
 * and the matching, filtering and key handling below are the whole of what it
 * would provide. Same shape as SuggestionHighlights.ts — plugin owns the
 * state, React reads it and draws.
 *
 * The plugin holds the selected index as well as the query, because Enter and
 * the arrow keys have to be handled here to beat ProseMirror's own bindings,
 * and a highlight that lived in React state could not be read from
 * handleKeyDown.
 */
import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";

export interface SlashItem {
  title: string;
  hint: string;
  /** Extra words this item should match, beyond its title. */
  keywords: string[];
  run: (editor: Editor, range: { from: number; to: number }) => void;
}

export const SLASH_ITEMS: SlashItem[] = [
  {
    title: "Text",
    hint: "Plain paragraph",
    keywords: ["paragraph", "body"],
    run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run(),
  },
  {
    title: "Heading 1",
    hint: "Big section title",
    keywords: ["h1", "title"],
    run: (e, r) =>
      e.chain().focus().deleteRange(r).toggleHeading({ level: 1 }).run(),
  },
  {
    title: "Heading 2",
    hint: "Section title",
    keywords: ["h2", "subtitle"],
    run: (e, r) =>
      e.chain().focus().deleteRange(r).toggleHeading({ level: 2 }).run(),
  },
  {
    title: "Heading 3",
    hint: "Sub-section",
    keywords: ["h3"],
    run: (e, r) =>
      e.chain().focus().deleteRange(r).toggleHeading({ level: 3 }).run(),
  },
  {
    title: "Bulleted list",
    hint: "An unordered list",
    keywords: ["ul", "bullet", "unordered"],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run(),
  },
  {
    title: "Numbered list",
    hint: "An ordered list",
    keywords: ["ol", "ordered", "number"],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run(),
  },
  {
    title: "Quote",
    hint: "Set text apart",
    keywords: ["blockquote", "citation"],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run(),
  },
  {
    title: "Code block",
    hint: "Monospaced block",
    keywords: ["pre", "snippet"],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run(),
  },
  {
    title: "Divider",
    hint: "Horizontal rule",
    keywords: ["hr", "rule", "separator", "line"],
    run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run(),
  },
];

export interface SlashState {
  /** Range covering "/" and everything typed after it, to be replaced. */
  range: { from: number; to: number };
  query: string;
  index: number;
  items: SlashItem[];
}

export const slashMenuKey = new PluginKey<SlashState | null>("slashMenu");

function filterItems(query: string): SlashItem[] {
  if (!query) return SLASH_ITEMS;
  const q = query.toLowerCase();
  return SLASH_ITEMS.filter(
    (i) =>
      i.title.toLowerCase().includes(q) ||
      i.keywords.some((k) => k.startsWith(q))
  );
}

/**
 * The "/…" being typed at the caret, or null.
 *
 * Requires the slash to start a word — after a space or at the start of the
 * block — so a URL or a fraction someone is writing mid-sentence does not
 * open a block menu on them.
 */
function detect(state: EditorState): { range: { from: number; to: number }; query: string } | null {
  const { $from, empty } = state.selection;
  if (!empty) return null;
  // Inside a code block "/" is just a character, and offering to turn code
  // into a heading is never what was meant.
  if ($from.parent.type.spec.code) return null;

  const textBefore = $from.parent.textBetween(
    0,
    $from.parentOffset,
    undefined,
    "￼"
  );
  const match = /(?:^|\s)\/([a-zA-Z]*)$/.exec(textBefore);
  if (!match) return null;

  const query = match[1];
  const to = $from.pos;
  const from = to - query.length - 1;
  return { range: { from, to }, query };
}

export const SlashMenu = Extension.create({
  name: "slashMenu",

  addProseMirrorPlugins() {
    const editor = this.editor;

    return [
      new Plugin<SlashState | null>({
        key: slashMenuKey,

        state: {
          init: () => null,

          apply(tr, prev, _oldState, newState) {
            // Escape sets this and the menu stays shut until the caret
            // leaves the run of text it was opened on — otherwise the next
            // keystroke, which re-matches, would pop it straight back up.
            if (tr.getMeta(slashMenuKey) === "dismiss") return null;

            const move = tr.getMeta(slashMenuKey);
            const found = detect(newState);
            if (!found) return null;

            const items = filterItems(found.query);
            if (items.length === 0) return null;

            let index = prev && prev.query === found.query ? prev.index : 0;
            if (typeof move === "number") index += move;
            // Wrap, so holding Down does not dead-end at the last item.
            index = ((index % items.length) + items.length) % items.length;

            return { ...found, index, items };
          },
        },

        props: {
          handleKeyDown(view, event) {
            const active = slashMenuKey.getState(view.state);
            if (!active) return false;

            if (event.key === "Escape") {
              view.dispatch(view.state.tr.setMeta(slashMenuKey, "dismiss"));
              return true;
            }
            if (event.key === "ArrowDown") {
              view.dispatch(view.state.tr.setMeta(slashMenuKey, 1));
              return true;
            }
            if (event.key === "ArrowUp") {
              view.dispatch(view.state.tr.setMeta(slashMenuKey, -1));
              return true;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              const item = active.items[active.index];
              if (!item) return false;
              item.run(editor, active.range);
              return true;
            }
            return false;
          },
        },
      }),
    ];
  },
});
