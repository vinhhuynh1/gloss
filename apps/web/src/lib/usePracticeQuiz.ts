/**
 * Asking for a practice quiz on your weak sections, and waiting for it.
 *
 * Polls by id, not "newest for the document" like useQuiz: a practice quiz is
 * one person's, and the document's newest row is the group quiz by
 * definition. The same hidden-tab rule as useQuiz applies (park without a
 * timer and let the visibility listener restart) for the same reason.
 *
 * The id lives only in this hook. Leaving the page while a practice quiz is
 * being written loses track of it; the spec accepts that rather than adding
 * a "latest practice quiz" route nobody has asked for yet.
 */
import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "./api";
import type { Quiz, QuizRow, QuizStatusRow } from "./types";
import { isSettled, MAX_RETRY_MS, POLL_MS } from "./useQuiz";

export function usePracticeQuiz(documentId: string) {
  const [row, setRow] = useState<QuizStatusRow | null>(null);
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [quizId, setQuizId] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  // A practice quiz belongs to the document it was asked on.
  useEffect(() => {
    setRow(null);
    setQuiz(null);
    setQuizId(null);
    setFetchError(null);
  }, [documentId]);

  const id = row?.id ?? null;
  const settled = row === null || isSettled(row.status);

  useEffect(() => {
    if (id === null || settled) return;
    let active = true;
    let timer: number | undefined;
    let failures = 0;

    async function tick() {
      if (document.hidden) return; // parked; onVisible restarts it
      try {
        const status = await apiFetch<QuizStatusRow>(`/quizzes/${id}`);
        if (!active) return;
        if (status.status === "done") {
          const full = await apiFetch<QuizRow>(`/quizzes/${id}/content`);
          if (!active) return;
          setQuiz(full.questions);
          setQuizId(full.id);
        }
        // After the content, so `running` only ends once the quiz is in hand.
        failures = 0;
        setFetchError(null);
        setRow(status);
        if (!isSettled(status.status)) timer = window.setTimeout(tick, POLL_MS);
      } catch (err) {
        if (!active) return;
        failures += 1;
        setFetchError(
          err instanceof Error ? err.message : "Could not load the practice quiz"
        );
        timer = window.setTimeout(tick, Math.min(POLL_MS * 2 ** failures, MAX_RETRY_MS));
      }
    }

    timer = window.setTimeout(tick, POLL_MS);
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
  }, [id, settled]);

  const start = useCallback(
    async (notes: string, sections: string[], sourceIds?: string[]) => {
      setAsking(true);
      setFetchError(null);
      setQuiz(null);
      setQuizId(null);
      try {
        const created = await apiFetch<QuizStatusRow>(
          `/documents/${documentId}/quiz/practice`,
          {
            method: "POST",
            body: JSON.stringify({ notes, sections, source_ids: sourceIds }),
          }
        );
        setRow(created);
      } catch (err) {
        setFetchError(
          err instanceof Error ? err.message : "Could not start the practice quiz"
        );
      } finally {
        setAsking(false);
      }
    },
    [documentId]
  );

  const running = row !== null && !isSettled(row.status);
  const error =
    fetchError ??
    (row?.status === "failed"
      ? row.error ?? "The practice quiz could not be written."
      : null);

  return { row, quiz, quizId, error, asking, running, start };
}
