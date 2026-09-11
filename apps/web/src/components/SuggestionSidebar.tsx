import { useEffect, useRef } from "react";

import type { Suggestion } from "../lib/types";
import { type TrackedRequest, WORKER_SUSPECT_MS } from "../lib/useSuggestions";

const TYPE_LABELS: Record<Suggestion["type"], string> = {
  citation: "Citation",
  contradiction: "Contradiction",
  gap_fill: "Gap",
};

interface SuggestionSidebarProps {
  suggestions: Suggestion[];
  requests: TrackedRequest[];
  /** Suggestions whose passage is still in the document. */
  anchoredIds: string[];
  focusedId: string | null;
  error: string | null;
  notice: string | null;
  onAccept: (s: Suggestion) => void;
  onReject: (s: Suggestion) => void;
  onDismissRequest: (id: string) => void;
  onFocus: (id: string | null) => void;
}

function RequestChip({
  request,
  onDismiss,
}: {
  request: TrackedRequest;
  onDismiss: () => void;
}) {
  const preview =
    request.passage.length > 60 ? `${request.passage.slice(0, 60)}…` : request.passage;

  if (request.status === "failed") {
    return (
      <div className="request-chip request-failed">
        <span>Check failed: {request.error ?? "unknown error"}</span>
        <button className="link-button" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    );
  }
  if (request.status === "done") {
    return <div className="request-chip request-clear">No issues found in “{preview}”</div>;
  }

  const stalled =
    request.status === "pending" && Date.now() - request.askedAt > WORKER_SUSPECT_MS;
  return (
    <div className="request-chip request-open">
      <span>Checking “{preview}”…</span>
      {stalled && (
        <p className="warning">
          Still waiting. A check waits for this space's uploads to finish
          processing — otherwise, is the agent worker running?
          <code>cd apps/agent-worker &amp;&amp; python worker.py</code>
        </p>
      )}
    </div>
  );
}

export default function SuggestionSidebar({
  suggestions,
  requests,
  anchoredIds,
  focusedId,
  error,
  notice,
  onAccept,
  onReject,
  onDismissRequest,
  onFocus,
}: SuggestionSidebarProps) {
  const cardRefs = useRef(new Map<string, HTMLDivElement>());

  // Clicking a highlight, or a check coming back, focuses a card; bring it
  // into view, since the list can be longer than the rail.
  useEffect(() => {
    if (focusedId) {
      cardRefs.current.get(focusedId)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [focusedId]);

  const anchored = new Set(anchoredIds);

  return (
    <aside className="suggestion-sidebar">
      <h2>AI suggestions</h2>
      <p className="muted">Select text in the notes and choose “Check with AI”.</p>

      {error && <p className="error">{error}</p>}
      {notice && <p className="warning">{notice}</p>}

      {requests.map((r) => (
        <RequestChip key={r.id} request={r} onDismiss={() => onDismissRequest(r.id)} />
      ))}

      {!error && suggestions.length === 0 && requests.length === 0 && (
        <p className="muted">Nothing pending.</p>
      )}

      {suggestions.map((s) => {
        const placed = anchored.has(s.id);
        // A suggestion made from the agent CLI never had a position; one whose
        // passage was deleted has lost it. Either way there is nowhere to put
        // the text, so it can only be dismissed.
        const unplaceable = !s.anchor.from
          ? "Made outside the editor, so it has no place in the notes."
          : "The passage this was about has been deleted.";
        return (
          <div
            key={s.id}
            ref={(el) => {
              if (el) cardRefs.current.set(s.id, el);
              else cardRefs.current.delete(s.id);
            }}
            className={`suggestion-card suggestion-${s.type}${
              focusedId === s.id ? " suggestion-focused" : ""
            }`}
            onMouseEnter={() => onFocus(s.id)}
          >
            <span className="suggestion-type">{TYPE_LABELS[s.type]}</span>
            {s.anchor.quote && <blockquote className="suggestion-quote">{s.anchor.quote}</blockquote>}
            <p>{s.proposed_text}</p>

            {(s.source_filename || s.source_excerpt) && (
              <details className="suggestion-source">
                <summary>
                  Source: {[s.source_filename, s.source_page_ref].filter(Boolean).join(", ") || "course material"}
                </summary>
                {s.source_excerpt && <p>{s.source_excerpt}</p>}
              </details>
            )}

            {!placed && <p className="muted">{unplaceable}</p>}

            <div className="suggestion-actions">
              {placed ? (
                <>
                  <button onClick={() => onAccept(s)}>Accept</button>
                  <button onClick={() => onReject(s)}>Reject</button>
                </>
              ) : (
                <button onClick={() => onReject(s)}>Dismiss</button>
              )}
            </div>
          </div>
        );
      })}
    </aside>
  );
}
