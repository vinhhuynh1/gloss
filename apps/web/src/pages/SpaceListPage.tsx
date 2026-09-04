import { useEffect, useState } from "react";

import { useAuth } from "../auth/AuthProvider";
import { apiFetch } from "../lib/api";
import type { StudySpace } from "../lib/types";

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
      setSpaces((prev) => [space, ...prev]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create space");
    }
  }

  return (
    <div className="space-list-page">
      <header className="app-header">
        <h1>Study spaces</h1>
        <div className="header-user">
          <span className="muted">{user?.email}</span>
          <button className="link-button" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>

      <form className="create-space" onSubmit={create}>
        <input
          value={courseName}
          onChange={(e) => setCourseName(e.target.value)}
          placeholder="Course name, e.g. BIOL 201"
        />
        <button type="submit">Create</button>
      </form>

      {error && <p className="error">{error}</p>}

      {loading ? (
        <p className="muted">Loading…</p>
      ) : spaces.length === 0 ? (
        <p className="muted">No study spaces yet. Create one above.</p>
      ) : (
        <ul className="space-list">
          {spaces.map((space) => (
            <li key={space.id}>
              <button className="space-row" onClick={() => onOpen(space)}>
                <strong>{space.course_name}</strong>
                <span className="muted">
                  {new Date(space.created_at).toLocaleDateString()}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
