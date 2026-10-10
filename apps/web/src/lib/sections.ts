/**
 * Notes headings as sections: the unit weak spots are counted in.
 *
 * A section is a heading of any level plus everything up to the next heading
 * of any level. Sections are keyed by heading text, compared ignoring case, so
 * two headings that read the same are one section. The alternative is
 * writing ids into the shared CRDT document, which every collaborator would
 * then have to merge (see DocumentOutline's header).
 *
 * The heading walk lives here rather than in DocumentOutline so the outline,
 * the quiz request and the practice request can never disagree about what
 * the headings are.
 */
import type { Editor } from "@tiptap/react";

export type Doc = Editor["state"]["doc"];

/** Match MAX_SECTIONS and MAX_SECTION_CHARS in apps/api/schemas.py. */
export const MAX_SECTIONS = 100;
const MAX_SECTION_CHARS = 200;

export interface HeadingEntry {
  /** ProseMirror document position, which is also a stable React key within
   * one render pass. */
  pos: number;
  level: number;
  text: string;
}

/** Every non-empty heading, in document order. An empty heading is someone
 * mid-thought on a fresh line, and is not a section. */
export function headingEntries(doc: Doc): HeadingEntry[] {
  const found: HeadingEntry[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "heading") return;
    const text = node.textContent.trim();
    if (text) found.push({ pos, level: node.attrs.level as number, text });
  });
  return found;
}

/** Distinct heading texts, first spelling wins, capped at MAX_SECTIONS. A
 * heading longer than MAX_SECTION_CHARS is a pasted sentence rather than a
 * section name, and is skipped rather than truncated: a truncated name would
 * no longer match the heading in the outline. */
export function sectionHeadings(doc: Doc): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { text } of headingEntries(doc)) {
    if (text.length > MAX_SECTION_CHARS) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length === MAX_SECTIONS) break;
  }
  return out;
}

/** The text of the named sections, joined the way readNotes joins blocks
 * ("\n\n"), so the worker splits it the same way it splits whole notes. */
export function sectionText(doc: Doc, headings: string[]): string {
  const wanted = new Set(headings.map((h) => h.trim().toLowerCase()));
  const entries = headingEntries(doc);
  const parts: string[] = [];
  entries.forEach((entry, i) => {
    if (!wanted.has(entry.text.toLowerCase())) return;
    const end = i + 1 < entries.length ? entries[i + 1].pos : doc.content.size;
    const text = doc.textBetween(entry.pos, end, "\n\n").trim();
    if (text) parts.push(text);
  });
  return parts.join("\n\n");
}
