/**
 * Pending suggestions as highlighted spans in the editor.
 *
 * Decorations, not marks: a mark would be document content, written into
 * the shared Yjs doc and synced to everyone, and would outlive the
 * suggestion it belonged to. A decoration is view-only, local to this
 * client, and gone the moment the suggestion is resolved.
 *
 * Positions come from each suggestion's Yjs anchor (lib/anchors.ts), but they
 * can only be recomputed from Yjs when Yjs and ProseMirror agree — on a
 * transaction that came from Yjs (a remote edit, undo, initial load) or when
 * the suggestion list itself changes. On a local keystroke ProseMirror is
 * already updated and Yjs is not yet, so the existing decorations are mapped
 * through the transaction instead. Same approach as y-prosemirror's own
 * cursor plugin.
 */
import { Extension } from "@tiptap/core";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ySyncPluginKey } from "y-prosemirror";

import { anchorToRange } from "../lib/anchors";
import type { Suggestion } from "../lib/types";

interface HighlightState {
  suggestions: Suggestion[];
  decorations: DecorationSet;
}

export const suggestionHighlightsKey = new PluginKey<HighlightState>(
  "suggestionHighlights"
);

function build(state: EditorState, suggestions: Suggestion[]): DecorationSet {
  const decorations: Decoration[] = [];
  for (const s of suggestions) {
    const range = anchorToRange(state, s.anchor);
    if (!range) continue;
    decorations.push(
      Decoration.inline(
        range.from,
        range.to,
        {
          class: `suggestion-highlight suggestion-highlight-${s.type}`,
          "data-suggestion-id": s.id,
        },
        // The spec is what findSuggestionRange() and anchoredSuggestionIds()
        // search by. inclusiveEnd off: typing right after the passage should
        // not grow the highlight over the new text.
        { suggestionId: s.id, inclusiveStart: false, inclusiveEnd: false }
      )
    );
  }
  return DecorationSet.create(state.doc, decorations);
}

/** Replace the set of suggestions to highlight. */
export function setHighlightedSuggestions(
  state: EditorState,
  suggestions: Suggestion[]
) {
  return state.tr.setMeta(suggestionHighlightsKey, suggestions);
}

/** The span a suggestion's highlight currently covers, or null if it has
 * none — which is exactly when its passage can no longer be found. */
export function findSuggestionRange(
  state: EditorState,
  suggestionId: string
): { from: number; to: number } | null {
  const set = suggestionHighlightsKey.getState(state)?.decorations;
  const found = set?.find(undefined, undefined, (spec) => spec.suggestionId === suggestionId);
  return found && found.length > 0 ? { from: found[0].from, to: found[0].to } : null;
}

/** Ids of the suggestions that currently have a highlight. */
export function anchoredSuggestionIds(state: EditorState): string[] {
  const set = suggestionHighlightsKey.getState(state)?.decorations;
  return (set?.find() ?? []).map((d) => d.spec.suggestionId as string);
}

export interface SuggestionHighlightsOptions {
  /** Called with a suggestion's id when its highlight is clicked. */
  onSelect: (suggestionId: string) => void;
}

export const SuggestionHighlights = Extension.create<SuggestionHighlightsOptions>({
  name: "suggestionHighlights",

  addOptions() {
    return { onSelect: () => {} };
  },

  addProseMirrorPlugins() {
    const { onSelect } = this.options;
    return [
      new Plugin<HighlightState>({
        key: suggestionHighlightsKey,
        state: {
          init: (_config, state) => ({
            suggestions: [],
            decorations: DecorationSet.create(state.doc, []),
          }),
          apply(tr, prev, _oldState, newState) {
            const next = tr.getMeta(suggestionHighlightsKey) as Suggestion[] | undefined;
            if (next) {
              return { suggestions: next, decorations: build(newState, next) };
            }
            if (tr.getMeta(ySyncPluginKey)?.isChangeOrigin) {
              return {
                suggestions: prev.suggestions,
                decorations: build(newState, prev.suggestions),
              };
            }
            if (!tr.docChanged) return prev;
            return {
              suggestions: prev.suggestions,
              decorations: prev.decorations.map(tr.mapping, tr.doc),
            };
          },
        },
        props: {
          decorations(state) {
            return suggestionHighlightsKey.getState(state)?.decorations;
          },
          handleClick(_view, _pos, event) {
            const target = event.target as HTMLElement | null;
            const id = target?.closest("[data-suggestion-id]")?.getAttribute("data-suggestion-id");
            if (id) onSelect(id);
            // Never consume the click: it still has to place the caret.
            return false;
          },
        },
      }),
    ];
  },
});
