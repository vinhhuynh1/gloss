import { Extension } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";
import { BubbleMenu, type Editor as TiptapEditor, EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef } from "react";
import type { WebsocketProvider } from "y-websocket";
import type * as Y from "yjs";

import EditorToolbar from "./EditorToolbar";
import SlashMenu from "./SlashMenu";
import {
  CommentHighlights,
  anchoredCommentPositions,
  setHighlightedThreads,
} from "../extensions/CommentHighlights";
import { SlashMenu as SlashMenuExtension } from "../extensions/SlashMenu";
import {
  SuggestionHighlights,
  anchoredSuggestionPositions,
  setHighlightedSuggestions,
} from "../extensions/SuggestionHighlights";
import { type PassageAnchor, selectionToAnchor } from "../lib/anchors";
import type { AnchoredAnnotation, CommentThread, Suggestion } from "../lib/types";

interface EditorProps {
  ydoc: Y.Doc;
  provider: WebsocketProvider;
  user: { name: string; color: string };
  /** Pending suggestions to highlight. */
  suggestions: Suggestion[];
  /** Unresolved comment threads to highlight. */
  threads: CommentThread[];
  /** The user asked for the selected passage to be checked. */
  onAskAi: (anchor: PassageAnchor) => void;
  /** The user asked to comment on the selected passage. */
  onComment: (anchor: PassageAnchor) => void;
  /** A highlight was clicked. */
  onSelectSuggestion: (suggestionId: string) => void;
  /** A comment highlight was clicked. */
  onSelectComment: (commentId: string) => void;
  /** Everything anchored in the text, in the order it appears there.
   *
   * One stream rather than two id lists: the margin shows suggestions and
   * comment threads together, ordered by position rather than grouped by
   * type, so the ordering has to be computed where the ProseMirror state
   * lives. Anything missing from this list has lost its passage. */
  onAnnotationsChange: (annotations: AnchoredAnnotation[]) => void;
  /** The editor instance, for applying accepted suggestions. */
  onEditor: (editor: TiptapEditor | null) => void;
}

export default function Editor({
  ydoc,
  provider,
  user,
  suggestions,
  threads,
  onAskAi,
  onComment,
  onSelectSuggestion,
  onSelectComment,
  onAnnotationsChange,
  onEditor,
}: EditorProps) {
  // useEditor runs with no deps and captures its options once (see the note
  // in lib/useCollabProvider.ts on why the editor must never be rebuilt), so
  // callbacks the extensions call go through refs that always hold the latest.
  const askRef = useRef(onAskAi);
  askRef.current = onAskAi;
  const commentRef = useRef(onComment);
  commentRef.current = onComment;
  const selectRef = useRef(onSelectSuggestion);
  selectRef.current = onSelectSuggestion;
  const selectCommentRef = useRef(onSelectComment);
  selectCommentRef.current = onSelectComment;

  const editor = useEditor({
    // No `content` option, deliberately. The Y.Doc is the document; passing
    // initial content alongside Collaboration appends it to the CRDT on every
    // load, so a placeholder paragraph would duplicate itself once per session
    // for every collaborator.
    extensions: [
      StarterKit.configure({ history: false }), // Yjs handles undo/history
      Collaboration.configure({ document: ydoc }),
      CollaborationCursor.configure({ provider, user }),
      SuggestionHighlights.configure({
        onSelect: (id) => selectRef.current(id),
      }),
      CommentHighlights.configure({
        onSelect: (id) => selectCommentRef.current(id),
      }),
      SlashMenuExtension,
      Extension.create({
        name: "askAiShortcut",
        addKeyboardShortcuts() {
          return {
            // Ctrl/Cmd+Alt+M, the same chord Google Docs uses to comment on a
            // selection. Ctrl+Shift+A was the first choice but Chrome keeps it
            // for tab search and the page never sees it.
            "Mod-Alt-m": ({ editor: e }) => {
              const anchor = selectionToAnchor(e.state);
              if (!anchor) return false;
              askRef.current(anchor);
              // Collapse to the end of the passage, as the button does: the
              // check is on its way and the highlight will mark the span.
              e.commands.setTextSelection(e.state.selection.to);
              return true;
            },
          };
        },
      }),
    ],
  });

  useEffect(() => {
    onEditor(editor);
    return () => onEditor(null);
  }, [editor, onEditor]);

  // Push the suggestion list into the highlight plugin whenever it changes.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.view.dispatch(setHighlightedSuggestions(editor.state, suggestions));
  }, [editor, suggestions]);

  // Same, for comment threads. A separate dispatch into a separate plugin —
  // see the note at the top of extensions/CommentHighlights.ts.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.view.dispatch(setHighlightedThreads(editor.state, threads));
  }, [editor, threads]);

  // Report everything anchored, in document order, after every transaction —
  // a collaborator deleting a passage is what removes one, and typing above
  // one is what reorders them.
  //
  // The key comparison keeps this from re-rendering the margin on every
  // keystroke: positions shift constantly while the *order* rarely changes.
  const annotationKey = useRef("");
  useEffect(() => {
    if (!editor) return;
    const report = () => {
      const merged: AnchoredAnnotation[] = [
        ...anchoredSuggestionPositions(editor.state).map((a) => ({
          ...a,
          kind: "suggestion" as const,
        })),
        ...anchoredCommentPositions(editor.state).map((a) => ({
          ...a,
          kind: "comment" as const,
        })),
      ].sort((a, b) => a.from - b.from);

      const key = merged.map((a) => `${a.kind}:${a.id}`).join(",");
      if (key !== annotationKey.current) {
        annotationKey.current = key;
        onAnnotationsChange(merged);
      }
    };
    report();
    editor.on("transaction", report);
    return () => {
      editor.off("transaction", report);
    };
  }, [editor, onAnnotationsChange]);

  /** The bubble-menu actions differ only in which callback they hand the
   * anchor to, so they share everything else: read the selection from editor
   * state rather than the DOM (the click blurs the editor, but ProseMirror
   * keeps its selection across a blur), then collapse to the end of the
   * passage, which is also what hides the bubble. */
  function fromSelection(hand: (anchor: PassageAnchor) => void) {
    if (!editor) return;
    const anchor = selectionToAnchor(editor.state);
    if (!anchor) return;
    hand(anchor);
    editor.chain().focus().setTextSelection(editor.state.selection.to).run();
  }

  return (
    <div className="editor-pane">
      <EditorToolbar editor={editor} />
      {editor && (
        <BubbleMenu editor={editor} tippyOptions={{ duration: 100, placement: "bottom" }}>
          <button
            className="ask-ai-button"
            // A plain click, deliberately not preventDefault on mousedown.
            // BubbleMenu flags its own mousedown so the blur it causes does
            // not hide the menu mid-click; suppress that blur and the flag
            // is left set, swallows the next real blur, and the bubble
            // sticks on screen after the editor loses focus.
            onClick={() => fromSelection(askRef.current)}
            title="Check this passage against the course material (Ctrl+Alt+M)"
          >
            ✨ Check with AI
          </button>
          <button
            className="comment-button"
            onClick={() => fromSelection(commentRef.current)}
            title="Comment on this passage"
          >
            💬 Comment
          </button>
        </BubbleMenu>
      )}
      <EditorContent editor={editor} />
      {/* Last, and a portal: see the note at the top of SlashMenu.tsx about
          why it must not be a sibling that BubbleMenu can trip over. */}
      <SlashMenu editor={editor} />
    </div>
  );
}
