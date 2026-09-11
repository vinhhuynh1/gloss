/**
 * Suggestions for one document, and the checks this user has asked for.
 *
 * Both come from polling. The answer to a check is written by a worker that
 * may be on someone's laptop (see apps/agent-worker/worker.py), so there is no
 * push channel to hear it on, and the realtime server deliberately knows
 * nothing about suggestions. Polling is fast while one of your own checks is
 * running, slow otherwise — slow still matters, because it is how a
 * collaborator's new suggestion, or their Accept, reaches this screen.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { PassageAnchor } from "./anchors";
import { ApiError, apiFetch } from "./api";
import type { AgentRequest, Suggestion } from "./types";

const FAST_POLL_MS = 2000;
const IDLE_POLL_MS = 10_000;

/** How long a check may sit unclaimed before the sidebar stops blaming
 * latency and asks whether the worker is running. A claimed check is one
 * retrieval query and one model call, so this is generous. Measured from
 * when this client asked, not from the server's created_at, so a skewed
 * clock cannot trigger it early. */
export const WORKER_SUSPECT_MS = 20_000;

/** How long "No issues found" stays up before clearing itself. */
const NO_ISSUES_MS = 6000;

export interface TrackedRequest extends AgentRequest {
  /** Client clock, when the request was made. */
  askedAt: number;
}

export type ResolveOutcome = "ok" | "conflict" | "error";

function isOpen(r: AgentRequest): boolean {
  return r.status === "pending" || r.status === "processing";
}

export function useSuggestions(
  documentId: string,
  /** Called once when one of this user's checks produces a suggestion. */
  onArrived?: (suggestionId: string) => void
) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [rows, setRows] = useState<AgentRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [pollToken, setPollToken] = useState(0);

  // Only checks asked for in this session are shown. The list endpoint also
  // returns ones that finished in the last few minutes, which after a reload
  // would resurface a "No issues found" nobody is waiting for.
  const askedAt = useRef(new Map<string, number>());
  const lastStatus = useRef(new Map<string, string>());
  const onArrivedRef = useRef(onArrived);
  onArrivedRef.current = onArrived;

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let first = true;

    async function tick() {
      // A hidden tab has nobody to show anything to, so the loop parks until
      // the visibility listener below restarts it. Never on the first run,
      // though: a page opened in a background tab should still have its
      // list when it is looked at, not a "Nothing pending" it has to correct.
      if (document.hidden && !first) return;
      first = false;

      let anyOpen = false;
      try {
        // Requests before suggestions, not in parallel: a check that finishes
        // between the two reads must never be seen as done while its
        // suggestion is still missing from the list.
        const requests = await apiFetch<AgentRequest[]>(
          `/documents/${documentId}/agent-requests`
        );
        const pending = await apiFetch<Suggestion[]>(
          `/suggestions/document/${documentId}`
        );
        if (!active) return;

        for (const r of requests) {
          const before = lastStatus.current.get(r.id);
          if (before && before !== "done" && r.status === "done" && r.suggestion_id) {
            onArrivedRef.current?.(r.suggestion_id);
          }
          lastStatus.current.set(r.id, r.status);
        }

        setRows(requests);
        setSuggestions(pending);
        setError(null);
        anyOpen = requests.some((r) => askedAt.current.has(r.id) && isOpen(r));
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Could not load suggestions");
      }
      timer = window.setTimeout(tick, anyOpen ? FAST_POLL_MS : IDLE_POLL_MS);
    }

    void tick();

    const onVisible = () => {
      if (!document.hidden) {
        window.clearTimeout(timer);
        void tick();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      active = false;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [documentId, pollToken]);

  const requests: TrackedRequest[] = rows
    .filter((r) => askedAt.current.has(r.id) && !dismissed.has(r.id))
    // A finished check that produced a suggestion needs no chip: the card
    // itself is the answer.
    .filter((r) => !(r.status === "done" && r.suggestion_id))
    .map((r) => ({ ...r, askedAt: askedAt.current.get(r.id)! }));

  const dismissRequest = useCallback((id: string) => {
    setDismissed((prev) => new Set(prev).add(id));
  }, []);

  // "No issues found" clears itself; failures stay until dismissed, because
  // they usually need someone to do something.
  const noIssueIds = requests
    .filter((r) => r.status === "done" && r.result_type === "none")
    .map((r) => r.id)
    .join(",");
  useEffect(() => {
    if (!noIssueIds) return;
    const timer = window.setTimeout(() => {
      setDismissed((prev) => {
        const next = new Set(prev);
        for (const id of noIssueIds.split(",")) next.add(id);
        return next;
      });
    }, NO_ISSUES_MS);
    return () => window.clearTimeout(timer);
  }, [noIssueIds]);

  const ask = useCallback(
    async (anchor: PassageAnchor) => {
      setNotice(null);
      try {
        const created = await apiFetch<AgentRequest>(
          `/documents/${documentId}/agent-requests`,
          { method: "POST", body: JSON.stringify({ passage: anchor.quote, anchor }) }
        );
        askedAt.current.set(created.id, Date.now());
        lastStatus.current.set(created.id, created.status);
        setRows((prev) => [...prev, created]);
        // Restart the loop at the fast rate straight away, rather than after
        // whatever is left of an idle wait.
        setPollToken((t) => t + 1);
      } catch (err) {
        setNotice(err instanceof Error ? err.message : "Could not start the check");
      }
    },
    [documentId]
  );

  /** Record a decision. The caller applies an accepted suggestion's text
   * only on "ok" — see applySuggestion. */
  const resolve = useCallback(
    async (id: string, accept: boolean): Promise<ResolveOutcome> => {
      setNotice(null);
      try {
        await apiFetch(`/suggestions/${id}/resolve`, {
          method: "POST",
          body: JSON.stringify({ accept }),
        });
        setSuggestions((prev) => prev.filter((s) => s.id !== id));
        return "ok";
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          setSuggestions((prev) => prev.filter((s) => s.id !== id));
          setNotice("Already handled by a collaborator.");
          return "conflict";
        }
        setNotice(err instanceof Error ? err.message : "Could not save decision");
        return "error";
      }
    },
    []
  );

  return {
    suggestions,
    requests,
    error,
    notice,
    setNotice,
    ask,
    resolve,
    dismissRequest,
  };
}
