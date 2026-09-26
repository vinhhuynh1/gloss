/**
 * The documents in this study space.
 *
 * Top of the left rail, above the outline: the outline is where you are
 * inside one document, this is which document you are in, and that is the
 * wider question of the two.
 *
 * Sources are deliberately not per-document. The corpus belongs to the
 * course, so a citation found for week 6 is just as valid in week 7, and
 * splitting it would mean uploading the same PDF once per page.
 */
import { useState } from "react";

import type { SpaceDocument } from "../lib/types";
import RowMenu from "./RowMenu";
import { IconDelete, IconDocument, IconNew, IconRename } from "./Icon";

export default function DocumentList({
  documents,
  currentId,
  busy,
  onOpen,
  onCreate,
  onRename,
  onDelete,
}: {
  documents: SpaceDocument[];
  currentId: string;
  busy: boolean;
  onOpen: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  function startRename(doc: SpaceDocument) {
    setRenaming(doc.id);
    setDraft(doc.title);
  }

  function commitRename(id: string) {
    const title = draft.trim();
    // An empty title would be refused by the API anyway (422); treating it as
    // "cancel" here is what someone clearing the field to retype expects.
    if (title) onRename(id, title);
    setRenaming(null);
  }

  return (
    <nav className="documents-panel" aria-label="Documents">
      <div className="documents-head">
        <h2>Documents</h2>
        <button
          className="icon-button"
          onClick={onCreate}
          disabled={busy}
          title="Add a document to this space"
          aria-label="Add a document to this space"
        >
          <IconNew />
        </button>
      </div>

      <ul className="document-list">
        {documents.map((doc) => {
          const current = doc.id === currentId;
          if (renaming === doc.id) {
            return (
              <li key={doc.id}>
                <input
                  className="document-rename"
                  value={draft}
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => commitRename(doc.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename(doc.id);
                    if (e.key === "Escape") setRenaming(null);
                  }}
                />
              </li>
            );
          }
          return (
            <li className="document-row" key={doc.id}>
              <button
                className={`document-item${current ? " is-current" : ""}`}
                title={doc.title}
                onClick={() => onOpen(doc.id)}
                onDoubleClick={() => startRename(doc)}
              >
                <IconDocument className="row-icon" />
                <span className="row-label">{doc.title}</span>
              </button>

              {/* On every row, not only the selected one. Actions that appear
                  merely because a row happens to be open are hard to find and
                  inconsistent between rows, which is why these used to sit in
                  a strip underneath. */}
              <RowMenu
                label={`Actions for ${doc.title}`}
                items={[
                  {
                    label: "Rename",
                    icon: <IconRename size={14} />,
                    onSelect: () => startRename(doc),
                  },
                  {
                    label: "Delete",
                    icon: <IconDelete size={14} />,
                    destructive: true,
                    // The API refuses the last document in a space with a 409.
                    // Disabling with a reason beats hiding: a control that
                    // vanishes looks like a bug, one that explains itself does
                    // not.
                    disabled: documents.length <= 1 || busy,
                    onSelect: () => onDelete(doc.id),
                  },
                ]}
              />
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
