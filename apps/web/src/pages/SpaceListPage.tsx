import { useEffect, useState } from "react";

import {
  IconDocument,
  IconNew,
  IconSignOut,
} from "../components/Icon";
import ThemeToggle from "../components/ThemeToggle";
import { useAuth } from "../auth/AuthProvider";
import { apiFetch } from "../lib/api";
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
          <span className="muted">{user?.email}</span>
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
            <button onClick={() => setCreating(true)}>
              <IconNew />
              Create your first space
            </button>
          </div>
        ) : (
          <ul className="space-grid">
            {spaces.map((space) => (
              <li key={space.id}>
                <button className="space-card" onClick={() => onOpen(space)}>
                  <span className="space-card-name">{space.course_name}</span>
                  <span className="space-card-meta">
                    {opened(space.created_at)}
                  </span>
                </button>
              </li>
            ))}

            <li>
              {creating ? (
                <form className="space-create" onSubmit={create}>
                  <input
                    value={courseName}
                    autoFocus
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
          </ul>
        )}
      </div>
    </div>
  );
}
