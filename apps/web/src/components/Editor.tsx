import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { WebsocketProvider } from "y-websocket";
import type * as Y from "yjs";

interface EditorProps {
  ydoc: Y.Doc;
  provider: WebsocketProvider;
  user: { name: string; color: string };
}

// TODO: pending suggestions should render as highlighted spans here. The
// straightforward way is a custom Tiptap extension that adds a decoration
// at each suggestion's Yjs relative position (converted to an absolute
// position at render time with Y.createAbsolutePositionFromRelativePosition)
// — see the "Suggestion UI" section of the build-plan doc. Left out of
// this scaffold so the collaborative-editing plumbing is easy to read on
// its own first.
export default function Editor({ ydoc, provider, user }: EditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ history: false }), // Yjs handles undo/history
      Collaboration.configure({ document: ydoc }),
      CollaborationCursor.configure({ provider, user }),
    ],
  });

  return (
    <div className="editor-pane">
      <EditorContent editor={editor} />
    </div>
  );
}
