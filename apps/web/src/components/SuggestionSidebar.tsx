import { useEffect, useState } from "react";

import { apiFetch } from "../lib/api";
import type { Suggestion } from "../lib/types";

export default function SuggestionSidebar({ documentId }: { documentId: string }) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    apiFetch<Suggestion[]>(`/suggestions/document/${documentId}`)
      .then((rows) => active && setSuggestions(rows))
      // Surfaced rather than swallowed: the previous catch turned every
      // failure into "Nothing pending", which hid a permanent 422 caused by
      // the placeholder document id.
      .catch((err) => active && setError(err.message));
    return () => {
      active = false;
    };
  }, [documentId]);

  async function resolve(id: string, accept: boolean) {
    // resolved_by is no longer sent — the API takes it from the caller's
    // token, so a client can only ever record a decision as itself.
    try {
      await apiFetch(`/suggestions/${id}/resolve`, {
        method: "POST",
        body: JSON.stringify({ accept }),
      });
      // TODO: on accept, also apply proposed_text into the Yjs doc at the
      // suggestion's anchor — this only records the decision server-side.
      setSuggestions((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save decision");
    }
  }

  return (
    <aside className="suggestion-sidebar">
      <h2>AI suggestions</h2>
      {error && <p className="error">{error}</p>}
      {!error && suggestions.length === 0 && <p className="muted">Nothing pending.</p>}
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
