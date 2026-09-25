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
          className="link-button"
          onClick={onCreate}
          disabled={busy}
          title="Add a document to this space"
        >
          + New
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
            <li key={doc.id}>
              <button
                className={`document-item${current ? " is-current" : ""}`}
                title={doc.title}
                onClick={() => onOpen(doc.id)}
                onDoubleClick={() => startRename(doc)}
              >
                {doc.title}
              </button>
              {current && (
                <span className="document-item-actions">
                  <button className="link-button" onClick={() => startRename(doc)}>
                    Rename
                  </button>
                  {/* Only offered when there is another document to fall back
                      to. The API refuses the last one with a 409; not showing
                      the button is friendlier than explaining the refusal. */}
                  {documents.length > 1 && (
                    <button
                      className="link-button"
                      onClick={() => onDelete(doc.id)}
                      disabled={busy}
                    >
                      Delete
                    </button>
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
