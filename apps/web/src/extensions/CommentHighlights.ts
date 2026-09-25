/**
 * Open comment threads as highlighted spans in the editor.
 *
 * A sibling of SuggestionHighlights rather than an extension of it. The two
 * do the same thing to different data, and merging them would mean one plugin
 * whose state has to stay correct for two independent lists that update on
 * different polls. That plugin is carrying the agent in production; this one
 * can fail without taking it down.
 *
 * Everything load-bearing is the same, and for the same reasons:
 *
 * - Decorations, not marks. A mark would be document content, written into
 *   the shared Yjs doc, synced to everyone, and left behind when the thread
 *   is resolved. A decoration is view-only and local to this client.
 * - Positions are recomputed from each thread's Yjs anchor only when Yjs and
 *   ProseMirror agree — on a Yjs-origin transaction, or when the thread list
 *   itself changes. On a local keystroke ProseMirror has moved and Yjs has
 *   not, so existing decorations are mapped through the transaction instead.
 *
 * Only unresolved roots are drawn. A resolved thread stays in the sidebar and
 * stops marking up the notes, which is the whole point of resolving it.
 */
import { Extension } from "@tiptap/core";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ySyncPluginKey } from "y-prosemirror";

import { anchorToRange } from "../lib/anchors";
import type { CommentThread } from "../lib/types";

interface CommentHighlightState {
  threads: CommentThread[];
  decorations: DecorationSet;
}

export const commentHighlightsKey = new PluginKey<CommentHighlightState>(
  "commentHighlights"
);

function build(state: EditorState, threads: CommentThread[]): DecorationSet {
  const decorations: Decoration[] = [];
  for (const thread of threads) {
    const anchor = thread.root.anchor;
    if (!anchor) continue;
    const range = anchorToRange(state, anchor);
    if (!range) continue;
    decorations.push(
      Decoration.inline(
        range.from,
        range.to,
        {
          class: "comment-highlight",
          "data-comment-id": thread.root.id,
        },
        // inclusiveEnd off, like the suggestion highlights: typing right after
        // a commented passage should not silently extend the comment over the
        // new words.
        { commentId: thread.root.id, inclusiveStart: false, inclusiveEnd: false }
      )
    );
  }
  return DecorationSet.create(state.doc, decorations);
}

/** Replace the set of threads to highlight. */
export function setHighlightedThreads(
  state: EditorState,
  threads: CommentThread[]
) {
  return state.tr.setMeta(commentHighlightsKey, threads);
}

/** The span a thread currently covers, or null when its passage is gone. */
export function findCommentRange(
  state: EditorState,
  commentId: string
): { from: number; to: number } | null {
  const set = commentHighlightsKey.getState(state)?.decorations;
  const found = set?.find(undefined, undefined, (spec) => spec.commentId === commentId);
  return found && found.length > 0 ? { from: found[0].from, to: found[0].to } : null;
}

/** Ids of the threads that still have a highlight. A thread missing from this
 * list is one whose passage a collaborator has deleted — the sidebar shows it
 * as detached rather than pretending it still points somewhere. */
export function anchoredCommentIds(state: EditorState): string[] {
  const set = commentHighlightsKey.getState(state)?.decorations;
  return (set?.find() ?? []).map((d) => d.spec.commentId as string);
}

export interface CommentHighlightsOptions {
  /** Called with a thread's id when its highlight is clicked. */
  onSelect: (commentId: string) => void;
}

export const CommentHighlights = Extension.create<CommentHighlightsOptions>({
  name: "commentHighlights",

  addOptions() {
    return { onSelect: () => {} };
  },

  addProseMirrorPlugins() {
    const { onSelect } = this.options;
    return [
      new Plugin<CommentHighlightState>({
        key: commentHighlightsKey,
        state: {
          init: (_config, state) => ({
            threads: [],
            decorations: DecorationSet.create(state.doc, []),
          }),
          apply(tr, prev, _oldState, newState) {
            const next = tr.getMeta(commentHighlightsKey) as
              | CommentThread[]
              | undefined;
            if (next) {
              return { threads: next, decorations: build(newState, next) };
            }
            if (tr.getMeta(ySyncPluginKey)?.isChangeOrigin) {
              return {
                threads: prev.threads,
                decorations: build(newState, prev.threads),
              };
            }
            if (!tr.docChanged) return prev;
            return {
              threads: prev.threads,
              decorations: prev.decorations.map(tr.mapping, tr.doc),
            };
          },
        },
        props: {
          decorations(state) {
            return commentHighlightsKey.getState(state)?.decorations;
          },
          handleClick(_view, _pos, event) {
            const target = event.target as HTMLElement | null;
            const id = target
              ?.closest("[data-comment-id]")
              ?.getAttribute("data-comment-id");
            if (id) onSelect(id);
            // Never consume the click: it still has to place the caret.
            return false;
          },
        },
      }),
    ];
  },
});
