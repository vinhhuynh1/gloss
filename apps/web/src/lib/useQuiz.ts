/**
 * Asking for a quiz and waiting for it.
 *
 * The same hook as useStudyGuide with a different noun, including every fix
 * that one has accumulated. Two in particular are not cosmetic:
 *
 * - A hidden tab parks the loop **without** a timer, and the visibility
 *   listener restarts it. Parking on a timer is what made the guide look
 *   frozen: browsers throttle timers in a backgrounded tab to roughly once a
 *   minute, and a quiz takes long enough that switching away while it runs is
 *   the normal path.
 * - A `done` row whose content fetch fails retries instead of ending the
 *   loop. Ending there left the quiz null with a reload as the only way out.
 *
 * Two calls, not one. The poll asks only for status; the quiz is fetched once
 * after. `notes` and `questions` are deferred columns on the server, so a poll
 * that returned the quiz would drag every question and every cited excerpt
 * out of Postgres every two seconds to say "still working".
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, apiFetch } from "./api";
import type { Quiz, QuizRow, QuizStatusRow } from "./types";

const POLL_MS = 2000;
const MAX_RETRY_MS = 30_000;

/** How long a quiz may sit unstarted before we stop blaming latency and
 * suggest the worker isn't running. Same reasoning and roughly the same
 * number as useStudyGuide's. */
export const WORKER_SUSPECT_MS = 25_000;

function isSettled(status: QuizStatusRow["status"]): boolean {
  return status === "done" || status === "failed";
}

export function useQuiz(documentId: string) {
  const [row, setRow] = useState<QuizStatusRow | null>(null);
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  // The row `quiz` was read from. Not row.id: the poll moves `row` to the
  // newest request the moment someone asks for another quiz, while `quiz`
  // keeps the old content until the new one is done. The view is keyed on
  // this, so answers never outlive the questions they were given against.
  const [quizId, setQuizId] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [pollToken, setPollToken] = useState(0);
  const askedAt = useRef<number | null>(null);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let failures = 0;
    let first = true;

    async function tick() {
      // Parks with no timer; onVisible below restarts it. Never on the first
      // run, so a tab opened in the background still has its finished quiz
      // ready when it is looked at.
      if (document.hidden && !first) return;
      first = false;

      let status: QuizStatusRow;
      try {
        status = await apiFetch<QuizStatusRow>(
          `/documents/${documentId}/quiz`
        );
      } catch (err) {
        if (!active) return;
        // A document nobody has asked about yet has no quiz, which is the
        // normal starting state rather than something to report.
        if (err instanceof ApiError && err.status === 404) {
          setRow(null);
          return;
        }
        setFetchError(
          err instanceof Error ? err.message : "Could not load the quiz"
        );
        failures += 1;
        timer = window.setTimeout(tick, Math.min(POLL_MS * 2 ** failures, MAX_RETRY_MS));
        return;
      }

      if (!active) return;
      failures = 0;
      setRow(status);
      setFetchError(null);
      // Someone who reloads while a quiz is running never went through ask(),
      // so without this the "is the worker running?" hint could never appear
      // for them.
      if (!isSettled(status.status) && askedAt.current === null) {
        askedAt.current = new Date(status.created_at).getTime();
      }

      let contentFailed = false;
      if (status.status === "done") {
        // Its own try: a 404 here is not "nothing has been asked for". The
        // status call reports the newest row whatever its state, while
        // /content insists the newest row is done, so another member asking
        // for a fresh quiz between the two calls 404s this one.
        try {
          const full = await apiFetch<QuizRow>(
            `/documents/${documentId}/quiz/content`
          );
          if (!active) return;
          setQuiz(full.questions);
          setQuizId(full.id);
        } catch (err) {
          if (!active) return;
          contentFailed = true;
          failures += 1;
          setFetchError(
            err instanceof Error ? err.message : "Could not load the quiz"
          );
        }
      }

      if (!isSettled(status.status)) timer = window.setTimeout(tick, POLL_MS);
      // A settled row normally ends the loop. A `done` row whose content
      // could not be fetched has an answer this hook merely failed to
      // collect, so that one case retries.
      else if (contentFailed) {
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

  const ask = useCallback(
    async (notes: string) => {
      // Refused here rather than by the API, for the same reason as the
      // guide: an empty document comes back 422, and a 422 is the one status
      // whose body FastAPI writes as a list of field errors. "notes: String
      // should have at least 1 character" is true and no use to someone who
      // just wants to be told the page is blank.
      if (notes.trim() === "") {
        setFetchError(
          "There are no notes to make a quiz from yet. Write something first."
        );
        return;
      }

      setAsking(true);
      setFetchError(null);
      try {
        // Cleared before the request: leaving the old quiz on screen while a
        // new one is written reads as though nothing happened.
        setQuiz(null);
        setQuizId(null);
        const created = await apiFetch<QuizStatusRow>(
          `/documents/${documentId}/quiz`,
          { method: "POST", body: JSON.stringify({ notes }) }
        );
        setRow(created);
        askedAt.current = Date.now();
        setPollToken((n) => n + 1);
      } catch (err) {
        setFetchError(
          err instanceof Error ? err.message : "Could not start the quiz"
        );
      } finally {
        setAsking(false);
      }
    },
    [documentId]
  );

  const running = row !== null && !isSettled(row.status);

  // A quiz the worker gave up on is a failure the person who clicked has to
  // see. Nothing else renders row.error.
  const error =
    fetchError ??
    (row?.status === "failed"
      ? row.error ?? "The quiz could not be written."
      : null);

  const workerSuspect =
    running &&
    row.status === "pending" &&
    askedAt.current !== null &&
    Date.now() - askedAt.current > WORKER_SUSPECT_MS;

  return { row, quiz, quizId, error, asking, running, workerSuspect, ask };
}
