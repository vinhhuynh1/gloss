import { Extension } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";
import { BubbleMenu, type Editor as TiptapEditor, EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef } from "react";
import type { WebsocketProvider } from "y-websocket";
import type * as Y from "yjs";

import {
  SuggestionHighlights,
  anchoredSuggestionIds,
  setHighlightedSuggestions,
} from "../extensions/SuggestionHighlights";
import { type PassageAnchor, selectionToAnchor } from "../lib/anchors";
import type { Suggestion } from "../lib/types";

interface EditorProps {
  ydoc: Y.Doc;
  provider: WebsocketProvider;
  user: { name: string; color: string };
  /** Pending suggestions to highlight. */
  suggestions: Suggestion[];
  /** The user asked for the selected passage to be checked. */
  onAskAi: (anchor: PassageAnchor) => void;
  /** A highlight was clicked. */
  onSelectSuggestion: (suggestionId: string) => void;
  /** Which suggestions currently have a highlight, i.e. can still be applied. */
  onAnchoredChange: (ids: string[]) => void;
  /** The editor instance, for applying accepted suggestions. */
  onEditor: (editor: TiptapEditor | null) => void;
}

export default function Editor({
  ydoc,
  provider,
  user,
  suggestions,
  onAskAi,
  onSelectSuggestion,
  onAnchoredChange,
  onEditor,
}: EditorProps) {
  // useEditor runs with no deps and captures its options once (see the note
  // in lib/useCollabProvider.ts on why the editor must never be rebuilt), so
  // callbacks the extensions call go through refs that always hold the latest.
  const askRef = useRef(onAskAi);
  askRef.current = onAskAi;
  const selectRef = useRef(onSelectSuggestion);
  selectRef.current = onSelectSuggestion;

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

  // Report which suggestions still have a highlight. Checked after every
  // transaction, because a collaborator deleting a passage is what removes one.
  const anchoredRef = useRef("");
  useEffect(() => {
    if (!editor) return;
    const report = () => {
      const ids = anchoredSuggestionIds(editor.state).sort();
      const key = ids.join(",");
      if (key !== anchoredRef.current) {
        anchoredRef.current = key;
        onAnchoredChange(ids);
      }
    };
    report();
    editor.on("transaction", report);
    return () => {
      editor.off("transaction", report);
    };
  }, [editor, onAnchoredChange]);

  function askFromSelection() {
    if (!editor) return;
    // Read from editor state, not the DOM: clicking the button blurs the
    // editor, but ProseMirror keeps the selection in its state across a blur.
    const anchor = selectionToAnchor(editor.state);
    if (!anchor) return;
    onAskAi(anchor);
    // Back into the editor with the selection collapsed to the end of the
    // passage, which is also what hides the bubble.
    editor.chain().focus().setTextSelection(editor.state.selection.to).run();
  }

  return (
    <div className="editor-pane">
      {editor && (
        <BubbleMenu editor={editor} tippyOptions={{ duration: 100, placement: "bottom" }}>
          <button
            className="ask-ai-button"
            // A plain click, deliberately not preventDefault on mousedown.
            // BubbleMenu flags its own mousedown so the blur it causes does
            // not hide the menu mid-click; suppress that blur and the flag
            // is left set, swallows the next real blur, and the bubble
            // sticks on screen after the editor loses focus.
            onClick={askFromSelection}
            title="Check this passage against the course material (Ctrl+Alt+M)"
          >
            ✨ Check with AI
          </button>
        </BubbleMenu>
      )}
      <EditorContent editor={editor} />
    </div>
  );
}
