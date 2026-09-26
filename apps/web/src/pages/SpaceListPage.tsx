import { useEffect, useMemo, useState } from "react";

import ConfirmDialog from "../components/ConfirmDialog";
import RowMenu from "../components/RowMenu";
import ThemeToggle from "../components/ThemeToggle";
import {
  IconDelete,
  IconDocument,
  IconNew,
  IconRename,
  IconSignOut,
} from "../components/Icon";
import { useAuth } from "../auth/AuthProvider";
import { apiFetch } from "../lib/api";
import { colorFromId } from "../lib/avatarColor";
import type { StudySpace } from "../lib/types";

/** Absolute for anything older than a week, relative below that.
 *
 * "3 days ago" is what someone actually wants to know about a space they were
 * last in this week; "11 Sep" is what they want for one they were not. A
 * single format is wrong at one end or the other. */
function opened(iso: string): string {
  const then = new Date(iso.endsWith("Z") ? iso : iso + "Z");
  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
  if (days <= 0) return "Created today";
  if (days === 1) return "Created yesterday";
  if (days < 7) return `Created ${days} days ago`;
  return `Created ${then.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: then.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  })}`;
}

/** The letter on a space's tile.
 *
 * Course names start with the code far more often than not — "BIOL 201",
 * "CS 2110" — so the first character carries more than an icon would, and a
 * grid of identical document glyphs tells you nothing about which card is
 * which. Paired with the hashed colour it makes each card findable by shape
 * before it is read. */
function monogram(name: string): string {
  const first = name.trim()[0];
  return first ? first.toUpperCase() : "?";
}

export default function SpaceListPage({
  onOpen,
}: {
  onOpen: (space: StudySpace) => void;
}) {
  const { user, signOut } = useAuth();
  const [spaces, setSpaces] = useState<StudySpace[]>([]);
  const [courseName, setCourseName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Creating is a card in the grid rather than a permanent form bar — the
  // same move the invite bar got, and for the same reason: it is an
  // occasional act that was holding prime space on every visit.
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingDelete, setPendingDelete] = useState<StudySpace | null>(null);
  /** Filters by name. Only rendered past a handful of spaces — a search box
   * over three cards is furniture. */
  const [query, setQuery] = useState("");

  async function load() {
    try {
      setSpaces(await apiFetch<StudySpace[]>("/study-spaces"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load spaces");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!courseName.trim()) return;
    try {
      const space = await apiFetch<StudySpace>("/study-spaces", {
        method: "POST",
        body: JSON.stringify({ course_name: courseName.trim() }),
      });
      setCourseName("");
      setCreating(false);
      setSpaces((prev) => [space, ...prev]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create space");
    }
  }

  // PATCH and DELETE have been on the API since the first migration and the
  // interface never called either: a space could be created and opened, and
  // nothing else, so a typo in a course name was permanent.
  async function rename(id: string) {
    const name = draft.trim();
    setRenaming(null);
    // An empty name would be refused by the API anyway (422); treating it as
    // "cancel" is what someone clearing the field to retype expects.
    if (!name) return;
    const before = spaces;
    setSpaces((prev) =>
      prev.map((s) => (s.id === id ? { ...s, course_name: name } : s))
    );
    try {
      await apiFetch<StudySpace>(`/study-spaces/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ course_name: name }),
      });
    } catch (err) {
      // Put the old name back rather than leave the grid showing one the
      // server never accepted.
      setSpaces(before);
      setError(err instanceof Error ? err.message : "Could not rename");
    }
  }

  async function remove(space: StudySpace) {
    setPendingDelete(null);
    const before = spaces;
    setSpaces((prev) => prev.filter((s) => s.id !== space.id));
    try {
      await apiFetch<void>(`/study-spaces/${space.id}`, { method: "DELETE" });
    } catch (err) {
      setSpaces(before);
      setError(err instanceof Error ? err.message : "Could not delete");
    }
  }

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? spaces.filter((s) => s.course_name.toLowerCase().includes(q)) : spaces;
  }, [spaces, query]);

  const searchable = spaces.length > 6;

  return (
    <div className="space-list-page">
      <header className="app-header">
        <h1>Study spaces</h1>
        {!loading && spaces.length > 0 && (
          <span className="muted header-count">
            {spaces.length} space{spaces.length === 1 ? "" : "s"}
          </span>
        )}
        <div className="header-user">
          {/* The address was the only thing saying who is signed in, set in
              muted grey beside a sign-out link — it read as a label rather
              than as you. The initial is the same one the share sheet gives
              this account, in the same colour. */}
          <span className="header-identity">
            <span
              className="share-avatar is-small"
              style={{ backgroundColor: colorFromId(user?.id ?? "") }}
              aria-hidden="true"
            >
              {monogram(user?.name || user?.email || "?")}
            </span>
            <span className="header-email">{user?.email}</span>
          </span>
          <ThemeToggle />
          <button
            className="link-button with-icon"
            onClick={() => void signOut()}
          >
            <IconSignOut />
            Sign out
          </button>
        </div>
      </header>

      <div className="page-shell">
        {error && <p className="error">{error}</p>}

        {searchable && (
          <div className="space-search">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by course name"
              aria-label="Filter spaces by course name"
            />
          </div>
        )}

        {loading ? (
          // The shape of what is coming, not the word "Loading". Three is a
          // guess at a typical count; it reads as "some cards" either way.
          <ul className="space-grid" aria-busy="true" aria-label="Loading spaces">
            {[0, 1, 2].map((i) => (
              <li key={i}>
                <div className="skeleton skeleton-card" />
              </li>
            ))}
          </ul>
        ) : spaces.length === 0 && !creating ? (
          <div className="empty-state">
            <IconDocument size={28} />
            <p className="empty-state-title">No study spaces yet</p>
            <p>
              A space is one course: its notes, the material the agent may cite,
              and the people you share it with.
            </p>
            <button className="with-icon" onClick={() => setCreating(true)}>
              <IconNew />
              Create your first space
            </button>
          </div>
        ) : shown.length === 0 ? (
          <div className="empty-state">
            <p className="empty-state-title">Nothing matches “{query}”</p>
            <button className="link-button" onClick={() => setQuery("")}>
              Clear the filter
            </button>
          </div>
        ) : (
          <ul className="space-grid">
            {shown.map((space) => {
              if (renaming === space.id) {
                return (
                  <li key={space.id}>
                    <form
                      className="space-card is-editing"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void rename(space.id);
                      }}
                    >
                      <input
                        value={draft}
                        autoFocus
                        aria-label="Course name"
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => void rename(space.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") setRenaming(null);
                        }}
                      />
                    </form>
                  </li>
                );
              }
              return (
                // The menu is a sibling of the card, not a child: a button
                // inside a button is invalid and the inner one stops opening.
                // Same shape the document rail uses.
                <li className="space-cell" key={space.id}>
                  <button className="space-card" onClick={() => onOpen(space)}>
                    <span
                      className="space-card-mark"
                      style={{ backgroundColor: colorFromId(space.id) }}
                      aria-hidden="true"
                    >
                      {monogram(space.course_name)}
                    </span>
                    <span className="space-card-name">{space.course_name}</span>
                    <span className="space-card-meta">
                      {opened(space.created_at)}
                    </span>
                  </button>
                  <RowMenu
                    label={`Actions for ${space.course_name}`}
                    items={[
                      {
                        label: "Rename",
                        icon: <IconRename size={14} />,
                        onSelect: () => {
                          setDraft(space.course_name);
                          setRenaming(space.id);
                        },
                      },
                      {
                        label: "Delete",
                        icon: <IconDelete size={14} />,
                        destructive: true,
                        onSelect: () => setPendingDelete(space),
                      },
                    ]}
                  />
                </li>
              );
            })}

            {!query && (
              <li>
                {creating ? (
                  <form className="space-card is-editing" onSubmit={create}>
                    <input
                      value={courseName}
                      autoFocus
                      aria-label="Course name"
                      onChange={(e) => setCourseName(e.target.value)}
                      placeholder="Course name, e.g. BIOL 201"
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          setCreating(false);
                          setCourseName("");
                        }
                      }}
                    />
                    <div className="space-create-actions">
                      <button type="submit" disabled={courseName.trim() === ""}>
                        Create
                      </button>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => {
                          setCreating(false);
                          setCourseName("");
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : (
                  <button
                    className="space-card is-new"
                    onClick={() => setCreating(true)}
                  >
                    <IconNew size={20} />
                    New space
                  </button>
                )}
              </li>
            )}
          </ul>
        )}
      </div>

      {/* A space owns its documents, sources, comments and everything the
          agent generated from them; the API cascades the lot. */}
      {pendingDelete && (
        <ConfirmDialog
          title={`Delete “${pendingDelete.course_name}”?`}
          body="Its documents, uploaded sources, comments and generated guides go with it. This cannot be undone."
          confirmLabel="Delete space"
          onConfirm={() => void remove(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
