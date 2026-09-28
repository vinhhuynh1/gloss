/**
 * Writing generated notes into the shared document.
 *
 * The notes arrive as the small format NOTES_SYSTEM_PROMPT asks for — "## "
 * and "### " headings, "- " bullets indented two spaces per level, **bold**,
 * and [n] page citations — and are built here into Tiptap nodes. Inserted
 * with an ordinary Tiptap command, so they reach every collaborator through
 * Yjs like typed text and a single undo takes them back out: the same rule
 * applySuggestion.ts keeps, that the agent never touches the document itself.
 *
 * Citations become the same bracketed source label an accepted suggestion
 * inserts, built from the stored snapshot rather than from anything the model
 * wrote, so a label in the notes cannot name a page that was not given.
 */
import type { Editor, JSONContent } from "@tiptap/core";

import type { ChatCitation } from "./types";

// "#" too, although the prompt asks for "##" and "###" only: the model
// sometimes opens with a title anyway, and inserting it as a literal "# "
// paragraph would be worse than taking it as the heading it plainly is.
const HEADING_RE = /^(#{1,3})\s+(.*)$/;
const BULLET_RE = /^(\s*)[-*]\s+(.*)$/;
// A line that is nothing but bold, "**Glycolysis**" or "**Glycolysis:**", is
// the model's heading where it was told not to write one. Taken as the H3 it
// is meant to be, so it lands in the outline rather than as a bold paragraph.
const BOLD_LINE_RE = /^\*\*([^*]+?):?\*\*:?$/;
// A run of adjacent markers, "[3][4]" or "[3] [4]", becomes one label.
const CITE_RUN_RE = /(?:\s?\[\d{1,4}\])+/g;
// **bold**, and *italic* — the prompt asks for no italics, but the model uses
// them now and then, and literal asterisks in the notes are worse than the
// emphasis it meant.
const EMPHASIS_RE = /\*\*(.+?)\*\*|\*([^*\s](?:[^*]*[^*\s])?)\*/g;

/** "slide 7" when every citation is from one file, since the file is then
 * obvious and repeating it on every bullet is noise; "deck.pptx, slide 7"
 * when the notes draw on several. */
function labeller(citations: ChatCitation[]): (c: ChatCitation) => string {
  const oneFile = new Set(citations.map((c) => c.filename)).size <= 1;
  return (c) =>
    oneFile ? c.page_ref ?? c.filename : [c.filename, c.page_ref].filter(Boolean).join(", ");
}

function inline(text: string, byN: Map<number, ChatCitation>, label: (c: ChatCitation) => string) {
  const withLabels = text.replace(CITE_RUN_RE, (run) => {
    const labels = [...run.matchAll(/\[(\d{1,4})\]/g)]
      .map((m) => byN.get(Number(m[1])))
      .filter((c): c is ChatCitation => c !== undefined)
      .map(label);
    const unique = [...new Set(labels)];
    return unique.length ? ` [${unique.join("; ")}]` : "";
  });

  const nodes: JSONContent[] = [];
  let last = 0;
  for (const m of withLabels.matchAll(EMPHASIS_RE)) {
    const at = m.index ?? 0;
    if (at > last) nodes.push({ type: "text", text: withLabels.slice(last, at) });
    nodes.push(
      m[1] !== undefined
        ? { type: "text", text: m[1], marks: [{ type: "bold" }] }
        : { type: "text", text: m[2], marks: [{ type: "italic" }] }
    );
    last = at + m[0].length;
  }
  if (last < withLabels.length) nodes.push({ type: "text", text: withLabels.slice(last) });
  // Tiptap rejects empty text nodes, and a bullet that was only a citation
  // for a page that was then dropped can leave nothing behind.
  return nodes.filter((n) => n.text);
}

/** The notes as a list of top-level block nodes. */
export function notesToContent(body: string, citations: ChatCitation[]): JSONContent[] {
  const byN = new Map(citations.map((c) => [c.n, c]));
  const label = labeller(citations);
  const blocks: JSONContent[] = [];
  // The open bullet lists, outermost first, each with the indent it was
  // opened at. A deeper bullet opens a list inside the last item; a
  // shallower one closes lists until it finds its level.
  let lists: { indent: number; node: JSONContent }[] = [];

  const paragraph = (text: string): JSONContent => {
    const content = inline(text, byN, label);
    return content.length ? { type: "paragraph", content } : { type: "paragraph" };
  };

  for (const raw of body.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (line.trim() === "") {
      lists = [];
      continue;
    }

    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      const indent = bullet[1].length;
      const item: JSONContent = { type: "listItem", content: [paragraph(bullet[2])] };
      while (lists.length && indent < lists[lists.length - 1].indent) lists.pop();
      const top = lists[lists.length - 1];
      if (top && indent === top.indent) {
        top.node.content!.push(item);
      } else if (top && indent > top.indent) {
        const parentItems = top.node.content!;
        const nested: JSONContent = { type: "bulletList", content: [item] };
        parentItems[parentItems.length - 1].content!.push(nested);
        lists.push({ indent, node: nested });
      } else {
        const list: JSONContent = { type: "bulletList", content: [item] };
        blocks.push(list);
        lists = [{ indent, node: list }];
      }
      continue;
    }

    lists = [];
    const boldLine = BOLD_LINE_RE.exec(line.trim());
    if (boldLine) {
      const content = inline(boldLine[1].trim(), byN, label);
      if (content.length) {
        blocks.push({ type: "heading", attrs: { level: 3 }, content });
        continue;
      }
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const content = inline(heading[2], byN, label);
      blocks.push({
        type: "heading",
        attrs: { level: heading[1].length },
        ...(content.length ? { content } : {}),
      });
    } else {
      blocks.push(paragraph(line.trim()));
    }
  }
  return blocks;
}

/**
 * Appends the notes to the end of the document, or fills it when it is
 * empty. At the end rather than at the cursor: the chat is not beside any
 * particular passage, and landing in the middle of whatever someone clicked
 * last would split their notes in two.
 *
 * `title` becomes an H2 over content that has no heading of its own: a chat
 * answer, which is written without them, would otherwise be invisible in the
 * outline once inserted. Notes carry their own "## " sections and keep them.
 *
 * Returns an error message, or null on success.
 */
export function insertNotes(
  editor: Editor,
  body: string,
  citations: ChatCitation[],
  title?: string
): string | null {
  const content = notesToContent(body, citations);
  if (content.length === 0) return "There is nothing in these notes to add.";
  const text = title?.trim();
  if (text && !content.some((b) => b.type === "heading" && (b.attrs?.level ?? 3) <= 2)) {
    content.unshift({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text }] });
  }
  const size = editor.state.doc.content.size;
  const at = editor.isEmpty ? { from: 0, to: size } : size;
  const ok = editor.chain().insertContentAt(at, content).scrollIntoView().run();
  return ok ? null : "The notes could not be added to this document.";
}
