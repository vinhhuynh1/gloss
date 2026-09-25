/**
 * The document's comments, and the writes that change them.
 *
 * Polls like useSuggestions rather than like useStudyGuide: comments never
 * settle. A classmate can reply at any time for as long as the tab is open,
 * so the loop idles rather than ending.
 *
 * The visibility handling is not optional and not copied by accident. A
 * hidden tab parks the loop *without* a timer and the listener at the bottom
 * restarts it. Parking on a timer instead is what broke the study guide: a
 * backgrounded tab has its timers throttled to roughly once a minute, so
 * coming back to the tab left the UI stale long enough to look frozen. See
 * the note in useStudyGuide.ts.
 *
 * One request returns roots and replies together. A document's comments are
 * small and bounded (MAX_COMMENT_CHARS each) and the editor needs all of them
 * to draw its highlights, so splitting the fetch would cost a round trip per
 * thread and buy nothing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiFetch } from "./api";
import type { Anchor, Comment, CommentThread } from "./types";

const POLL_MS = 8000;
const MAX_RETRY_MS = 60_000;

/** Roots with their replies, newest thread last. Resolved threads are kept —
 * the sidebar filters them, and they are already in hand. */
export function groupThreads(comments: Comment[]): CommentThread[] {
  const roots = comments.filter((c) => c.parent_id === null);
  const byParent = new Map<string, Comment[]>();
  for (const c of comments) {
    if (c.parent_id === null) continue;
    const list = byParent.get(c.parent_id);
    if (list) list.push(c);
    else byParent.set(c.parent_id, [c]);
  }
  return roots.map((root) => ({ root, replies: byParent.get(root.id) ?? [] }));
}

export function useComments(documentId: string) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Bumped after a write so the next poll is immediate rather than up to
  // POLL_MS away. Same device as useSuggestions' pollToken.
  const [pollToken, setPollToken] = useState(0);
  // Read inside tick() so a refresh triggered by a write does not have to
  // wait for the effect to re-run.
  const refresh = useCallback(() => setPollToken((n) => n + 1), []);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let failures = 0;
    let first = true;

    async function tick() {
      // Parks with no timer; onVisible below is what restarts it. Never on
      // the first run, so a tab opened in the background still has its
      // comments when it is looked at.
      if (document.hidden && !first) return;
      first = false;

      try {
        const rows = await apiFetch<Comment[]>(`/documents/${documentId}/comments`);
        if (!active) return;
        failures = 0;
        setComments(rows);
        setError(null);
        timer = window.setTimeout(tick, POLL_MS);
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Could not load comments");
        failures += 1;
        timer = window.setTimeout(
          tick,
          Math.min(POLL_MS * 2 ** failures, MAX_RETRY_MS)
        );
      }
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

  /** Wraps a write so every one of them reports failure the same way and
   * refreshes on success. Returns true when the write landed. */
  const write = useCallback(
    async (fn: () => Promise<unknown>, whenItFails: string) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        if (!mounted.current) return false;
        refresh();
        return true;
      } catch (err) {
        if (!mounted.current) return false;
        setError(err instanceof Error ? err.message : whenItFails);
        return false;
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [refresh]
  );

  const addThread = useCallback(
    (anchor: Anchor, quote: string, body: string) =>
      write(
        () =>
          apiFetch<Comment>(`/documents/${documentId}/comments`, {
            method: "POST",
            body: JSON.stringify({ anchor, quote, body }),
          }),
        "Could not post the comment"
      ),
    [documentId, write]
  );

  const addReply = useCallback(
    (rootId: string, body: string) =>
      write(
        () =>
          apiFetch<Comment>(
            `/documents/${documentId}/comments/${rootId}/replies`,
            { method: "POST", body: JSON.stringify({ body }) }
          ),
        "Could not post the reply"
      ),
    [documentId, write]
  );

  const editComment = useCallback(
    (id: string, body: string) =>
      write(
        () =>
          apiFetch<Comment>(`/documents/${documentId}/comments/${id}`, {
            method: "PATCH",
            body: JSON.stringify({ body }),
          }),
        "Could not save the edit"
      ),
    [documentId, write]
  );

  const setResolved = useCallback(
    (id: string, resolved: boolean) =>
      write(
        () =>
          apiFetch<Comment>(
            `/documents/${documentId}/comments/${id}/resolve?resolved=${resolved}`,
            { method: "POST" }
          ),
        "Could not update the thread"
      ),
    [documentId, write]
  );

  const removeComment = useCallback(
    (id: string) =>
      write(
        () =>
          apiFetch<void>(`/documents/${documentId}/comments/${id}`, {
            method: "DELETE",
          }),
        "Could not delete the comment"
      ),
    [documentId, write]
  );

  const threads = useMemo(() => groupThreads(comments), [comments]);

  /** Roots that still want attention — the ones the editor highlights. */
  const openThreads = useMemo(
    () => threads.filter((t) => t.root.resolved_at === null),
    [threads]
  );

  return {
    threads,
    openThreads,
    error,
    busy,
    addThread,
    addReply,
    editComment,
    setResolved,
    removeComment,
    refresh,
  };
}
