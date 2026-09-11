/**
 * Suggestion anchors: pinning a suggestion to a span of the shared document
 * in a way that survives other people's edits.
 *
 * A ProseMirror position is an integer offset into one client's copy of the
 * document, and it is wrong the moment anyone types above it. A Yjs relative
 * position instead names the CRDT item the span starts at, so it keeps
 * pointing at the same characters however much text is inserted or deleted
 * around them, on every client, across reloads. That is what the worker
 * stores on the suggestion, and what the highlight is rebuilt from.
 *
 * The conversions go through y-prosemirror's binding, which owns the mapping
 * between ProseMirror nodes and Yjs types. It only exists once the
 * Collaboration extension's sync plugin has initialised, so both directions
 * return null until then.
 */
import type { EditorState } from "@tiptap/pm/state";
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from "y-prosemirror";
import * as Y from "yjs";

import type { Anchor } from "./types";

/** The two relative positions plus the text they bounded when created. */
export interface PassageAnchor {
  from: unknown;
  to: unknown;
  quote: string;
}

function yBinding(state: EditorState) {
  const binding = ySyncPluginKey.getState(state)?.binding;
  // An empty mapping means the binding exists but has not rendered the Yjs
  // document into ProseMirror yet; positions computed against it are
  // meaningless.
  return binding && binding.mapping.size > 0 ? binding : null;
}

/** The current selection as an anchor, or null if nothing is selected. */
export function selectionToAnchor(state: EditorState): PassageAnchor | null {
  const { from, to, empty } = state.selection;
  if (empty) return null;

  const quote = state.doc.textBetween(from, to, "\n").trim();
  if (!quote) return null;

  const binding = yBinding(state);
  if (!binding) return null;

  return {
    from: Y.relativePositionToJSON(
      absolutePositionToRelativePosition(from, binding.type, binding.mapping)
    ),
    to: Y.relativePositionToJSON(
      absolutePositionToRelativePosition(to, binding.type, binding.mapping)
    ),
    quote,
  };
}

/**
 * The anchor's current span in this client's document, or null if it cannot
 * be placed: an anchor from the CLI (no positions), a binding that is not
 * ready, or text that has since been deleted — a deleted span collapses to an
 * empty range, which is treated the same as missing.
 *
 * Only valid when ProseMirror and Yjs agree. During a local edit ProseMirror
 * updates first and Yjs a moment later, so SuggestionHighlights calls this
 * only on Yjs-originated transactions and maps positions otherwise.
 */
export function anchorToRange(
  state: EditorState,
  anchor: Anchor
): { from: number; to: number } | null {
  if (!anchor.from || !anchor.to) return null;

  const binding = yBinding(state);
  if (!binding) return null;

  const resolve = (json: unknown) =>
    relativePositionToAbsolutePosition(
      binding.doc,
      binding.type,
      Y.createRelativePositionFromJSON(json),
      binding.mapping
    );

  const from = resolve(anchor.from);
  const to = resolve(anchor.to);
  const size = state.doc.content.size;
  if (from === null || to === null || from >= to || to > size) return null;
  return { from, to };
}
