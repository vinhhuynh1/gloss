/**
 * The space chat: the shared thread, and asking into it.
 *
 * Polls like useComments — a classmate can ask at any time — but by cursor
 * rather than by refetching the list. The thread only grows, and while an
 * answer streams the one row that changes is rewritten every half second, so
 * a poll asks for rows whose updated_at is past the newest one already seen
 * and merges them in by id. The API re-reads a few seconds behind the cursor
 * (SINCE_OVERLAP in routers/chat.py), which is why merging has to be by id
 * and not an append.
 *
 * Fast while an answer is open, slow while the panel is merely open, and not
 * at all while it is closed with nothing in flight: the chat is collapsed
 * most of the time, and a poll nobody can see is a request for nothing.
 *
 * The visibility handling is the same as useComments', and not optional —
 * see the note there on what a timer-parked hidden tab did to the study
 * guide.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError, apiFetch } from "./api";
import type { ChatMessage, NotesMode, OutlineSection } from "./types";

/** What turns a question into a request for notes. */
export interface NotesRequest {
  sourceIds: string[];
  /** The open document's text, so the notes skip what it already says. */
  existing: string;
  mode: NotesMode;
  documentId: string | null;
}

/** Approving a plan: the plan's id and its outline as edited. */
export interface PlanApproval {
  planId: string;
  outline: OutlineSection[];
  existing: string;
}

const STREAMING_POLL_MS = 1000;
const IDLE_POLL_MS = 6000;
const MAX_RETRY_MS = 60_000;

/** Matches PAGE_SIZE in apps/api/routers/chat.py. A full page means there may
 * be more behind it; a short one means the start of the thread. */
const PAGE_SIZE = 40;

/** Timestamps arrive with an offset from the chat endpoints, but the
 * convention elsewhere in this API is naive UTC — read either as UTC. */
export function parseTime(iso: string): number {
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + "Z");
}

function isOpen(m: ChatMessage): boolean {
  return m.role === "assistant" && (m.status === "pending" || m.status === "processing");
}

function merge(into: Map<string, ChatMessage>, rows: ChatMessage[]) {
  for (const row of rows) into.set(row.id, row);
}

export function useChat(spaceId: string, active: boolean) {
  // Keyed by id so a row seen twice — the overlap, or a poll racing the POST
  // that created it — replaces itself instead of appearing twice.
  const [byId, setById] = useState<Map<string, ChatMessage>>(new Map());
  const [loaded, setLoaded] = useState(false);
  const [hasEarlier, setHasEarlier] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pollToken, setPollToken] = useState(0);

  // Read inside the poll loop, which must not restart every time a message
  // arrives — that would turn each poll into two.
  const cursor = useRef<string | null>(null);
  const latest = useRef(byId);
  latest.current = byId;

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const messages = useMemo(
    () =>
      [...byId.values()].sort(
        (a, b) => parseTime(a.created_at) - parseTime(b.created_at)
      ),
    [byId]
  );
  const answering = messages.some(isOpen);

  const absorb = useCallback((rows: ChatMessage[]) => {
    if (rows.length === 0) return;
    for (const row of rows) {
      if (!cursor.current || parseTime(row.updated_at) > parseTime(cursor.current)) {
        cursor.current = row.updated_at;
      }
    }
    setById((prev) => {
      const next = new Map(prev);
      merge(next, rows);
      return next;
    });
  }, []);

  // A different space is a different thread: start again from nothing.
  useEffect(() => {
    setById(new Map());
    setLoaded(false);
    setHasEarlier(false);
    setError(null);
    cursor.current = null;
  }, [spaceId]);

  useEffect(() => {
    if (!active && !answering) return;

    let live = true;
    let timer: number | undefined;
    let failures = 0;
    let first = true;

    async function tick() {
      if (document.hidden && !first) return;
      first = false;

      try {
        if (cursor.current === null) {
          const rows = await apiFetch<ChatMessage[]>(`/study-spaces/${spaceId}/chat`);
          if (!live) return;
          absorb(rows);
          setHasEarlier(rows.length === PAGE_SIZE);
          setLoaded(true);
        } else {
          const since = encodeURIComponent(cursor.current);
          const rows = await apiFetch<ChatMessage[]>(
            `/study-spaces/${spaceId}/chat?since=${since}`
          );
          if (!live) return;
          absorb(rows);
        }
        failures = 0;
        setError(null);
        const streaming = [...latest.current.values()].some(isOpen);
        timer = window.setTimeout(tick, streaming ? STREAMING_POLL_MS : IDLE_POLL_MS);
      } catch (err) {
        if (!live) return;
        setError(err instanceof Error ? err.message : "Could not load the chat");
        failures += 1;
        timer = window.setTimeout(
          tick,
          Math.min(IDLE_POLL_MS * 2 ** failures, MAX_RETRY_MS)
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
      live = false;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [spaceId, active, answering, pollToken, absorb]);

  /** Returns true when the question was accepted, so the composer knows
   * whether to clear. `notes` turns it into a request to write notes from
   * whole files, with body as the instructions; `approval` writes the notes a
   * plan describes. */
  const ask = useCallback(
    async (body: string, notes?: NotesRequest, approval?: PlanApproval) => {
      setSending(true);
      setError(null);
      try {
        const payload = approval
          ? {
              body,
              kind: "notes",
              plan_id: approval.planId,
              outline: approval.outline,
              notes: approval.existing,
            }
          : notes
            ? {
                body,
                kind: "notes",
                source_ids: notes.sourceIds,
                notes: notes.existing,
                mode: notes.mode,
                document_id: notes.documentId,
              }
            : { body };
        const rows = await apiFetch<ChatMessage[]>(`/study-spaces/${spaceId}/chat`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        if (!mounted.current) return false;
        absorb(rows);
        setPollToken((n) => n + 1);
        return true;
      } catch (err) {
        if (!mounted.current) return false;
        setError(err instanceof Error ? err.message : "Could not send the question");
        return false;
      } finally {
        if (mounted.current) setSending(false);
      }
    },
    [spaceId, absorb]
  );

  const retry = useCallback(
    async (answerId: string) => {
      setError(null);
      try {
        const row = await apiFetch<ChatMessage>(
          `/study-spaces/${spaceId}/chat/${answerId}/retry`,
          { method: "POST" }
        );
        if (!mounted.current) return;
        absorb([row]);
        setPollToken((n) => n + 1);
      } catch (err) {
        if (!mounted.current) return;
        setError(err instanceof Error ? err.message : "Could not retry");
      }
    },
    [spaceId, absorb]
  );

  /** Claim the right to insert these notes. True means insert now; false
   * means someone — or another tab — already has, and this one must not. */
  const claimApply = useCallback(
    async (answerId: string) => {
      try {
        const row = await apiFetch<ChatMessage>(
          `/study-spaces/${spaceId}/chat/${answerId}/apply`,
          { method: "POST" }
        );
        if (mounted.current) absorb([row]);
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) return false;
        throw err;
      }
    },
    [spaceId, absorb]
  );

  /** Give a claim back after an insert that did not happen. */
  const releaseApply = useCallback(
    async (answerId: string) => {
      await apiFetch<void>(`/study-spaces/${spaceId}/chat/${answerId}/apply`, {
        method: "DELETE",
      }).catch(() => undefined);
      setPollToken((n) => n + 1);
    },
    [spaceId]
  );

  const loadEarlier = useCallback(async () => {
    const oldest = messages[0];
    if (!oldest) return;
    setLoadingEarlier(true);
    try {
      const before = encodeURIComponent(oldest.created_at);
      const rows = await apiFetch<ChatMessage[]>(
        `/study-spaces/${spaceId}/chat?before=${before}`
      );
      if (!mounted.current) return;
      absorb(rows);
      setHasEarlier(rows.length === PAGE_SIZE);
    } catch (err) {
      if (!mounted.current) return;
      setError(err instanceof Error ? err.message : "Could not load earlier messages");
    } finally {
      if (mounted.current) setLoadingEarlier(false);
    }
  }, [spaceId, messages, absorb]);

  return {
    messages,
    loaded,
    answering,
    hasEarlier,
    loadingEarlier,
    sending,
    error,
    ask,
    retry,
    loadEarlier,
    claimApply,
    releaseApply,
  };
}
