import { useEffect, useState } from "react";

// Matches packages/shared/types.ts — duplicated here rather than imported
// so this scaffold has no cross-package build config to set up. Point this
// at the shared package once the monorepo has a build step wired up.
interface Suggestion {
  id: string;
  type: "citation" | "contradiction" | "gap_fill";
  proposed_text: string;
  source_chunk_id: string | null;
}

const API_BASE_URL = "http://localhost:8000";
const CURRENT_USER_ID = "TODO-real-user-id";

export default function SuggestionSidebar({ documentId }: { documentId: string }) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);

  useEffect(() => {
    fetch(`${API_BASE_URL}/suggestions/document/${documentId}`)
      .then((res) => res.json())
      .then(setSuggestions)
      .catch(() => setSuggestions([]));
  }, [documentId]);

  async function resolve(id: string, accept: boolean) {
    await fetch(`${API_BASE_URL}/suggestions/${id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolved_by: CURRENT_USER_ID, accept }),
    });
    // TODO: on accept, also apply proposed_text into the Yjs doc at the
    // suggestion's anchor — this only records the decision server-side.
    setSuggestions((prev) => prev.filter((s) => s.id !== id));
  }

  return (
    <aside className="suggestion-sidebar">
      <h2>AI suggestions</h2>
      {suggestions.length === 0 && <p className="muted">Nothing pending.</p>}
      {suggestions.map((s) => (
        <div key={s.id} className={`suggestion-card suggestion-${s.type}`}>
          <span className="suggestion-type">{s.type.replace("_", " ")}</span>
          <p>{s.proposed_text}</p>
          <div className="suggestion-actions">
            <button onClick={() => resolve(s.id, true)}>Accept</button>
            <button onClick={() => resolve(s.id, false)}>Reject</button>
          </div>
        </div>
      ))}
    </aside>
  );
}
