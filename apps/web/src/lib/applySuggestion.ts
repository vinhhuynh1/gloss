/**
 * Writing an accepted suggestion into the shared document.
 *
 * Every change here is an ordinary Tiptap command, so it goes through the
 * Collaboration extension into Yjs and reaches every collaborator exactly
 * like typed text — undoable, attributable, and never a special path. The
 * agent itself never touches the document; this runs only after a person
 * clicked Accept and the API recorded the decision.
 *
 * Nothing here replaces the group's own words. A contradiction is added as a
 * note after the passage it flags, and the group decides how to fix the text.
 */
import type { Editor } from "@tiptap/core";

import { findSuggestionRange } from "../extensions/SuggestionHighlights";
import type { Suggestion } from "./types";

/** "(lecture-3.pdf, p. 12)" — or as much of it as the snapshot has. */
function sourceLabel(s: Suggestion): string {
  const parts = [s.source_filename, s.source_page_ref].filter(Boolean);
  return parts.join(", ");
}

/**
 * Applies the suggestion at its highlight. Returns an error message, or null
 * on success.
 */
export function applySuggestion(editor: Editor, s: Suggestion): string | null {
  const range = findSuggestionRange(editor.state, s.id);
  if (!range) {
    return "The passage this suggestion was about has been deleted, so it could not be applied.";
  }

  const label = sourceLabel(s);
  const text = s.proposed_text.trim();

  // Block-level additions go after the top-level block that contains the end
  // of the passage — a paragraph, or the whole list if the passage is in one —
  // so they never split a sentence or land inside a list item.
  const $end = editor.state.doc.resolve(range.to);
  const afterBlock = $end.depth >= 1 ? $end.after(1) : range.to;

  switch (s.type) {
    case "citation": {
      // Built from the stored source snapshot, not from model-written text:
      // a citation is only worth inserting if it cannot be invented.
      if (!label) return "This suggestion has no source to cite.";
      editor.chain().insertContentAt(range.to, ` [${label}]`).run();
      return null;
    }
    case "gap_fill": {
      if (!text) return "This suggestion has no text to add.";
      editor
        .chain()
        .insertContentAt(afterBlock, {
          type: "paragraph",
          content: [{ type: "text", text: label ? `${text} [${label}]` : text }],
        })
        .run();
      return null;
    }
    case "contradiction": {
      if (!text) return "This suggestion has no explanation to add.";
      editor
        .chain()
        .insertContentAt(afterBlock, {
          type: "blockquote",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: `⚠ Conflicts with the source: ${text}${label ? ` (${label})` : ""}`,
                },
              ],
            },
          ],
        })
        .run();
      return null;
    }
  }
}
