/**
 * Asking for a study guide and waiting for it.
 *
 * Polls like SourcesPanel rather than like useSuggestions: a guide settles.
 * Once it is done or failed there is no answer left to change, so the loop
 * ends instead of idling forever — and a hidden tab parks it, because nobody
 * is watching the spinner.
 *
 * Two calls, not one. The poll asks only for status; the guide itself is
 * fetched once, after. On the server both `notes` and `guide` are deferred
 * columns, so a poll that returned the guide would drag the whole document
 * out of Postgres every two seconds to say "still working".
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, apiFetch } from "./api";
import type { Guide, StudyGuideStatusRow, StudyGuideRow } from "./types";

const POLL_MS = 2000;
const MAX_RETRY_MS = 30_000;

/** How long a guide may sit unstarted before we stop blaming latency and
 * suggest the worker isn't running — the same reasoning, and roughly the same
 * number, as SourcesPanel's WORKER_SUSPECT_MS. A guide is a longer job than a
 * check, so this only covers the wait before it is claimed. */
export const WORKER_SUSPECT_MS = 25_000;

function isSettled(status: StudyGuideStatusRow["status"]): boolean {
  return status === "done" || status === "failed";
}

export function useStudyGuide(documentId: string) {
  const [row, setRow] = useState<StudyGuideStatusRow | null>(null);
  const [guide, setGuide] = useState<Guide | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  // Bumped by ask() to restart the poll, which has usually already exited by
  // then. Same device as SourcesPanel's pollToken.
  const [pollToken, setPollToken] = useState(0);
  const askedAt = useRef<number | null>(null);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let failures = 0;
    let first = true;

    async function tick() {
      // A hidden tab has nobody watching the spinner, so the loop parks until
      // the visibility listener below restarts it — the same arrangement as
      // useSuggestions. Parking on a timer instead does not work: browsers
      // throttle timers in a backgrounded tab to roughly once a minute, so
      // coming back to the tab left a finished guide unfetched for long enough
      // to look like it had never finished, and a reload was the only way
      // through. A guide takes minutes, so switching away while it runs is the
      // normal path rather than an edge case.
      //
      // Never on the first run, though: a page opened in a background tab
      // should still have its finished guide ready when it is looked at.
      if (document.hidden && !first) return;
      first = false;

      let status: StudyGuideStatusRow;
      try {
        status = await apiFetch<StudyGuideStatusRow>(
          `/documents/${documentId}/study-guide`
        );
      } catch (err) {
        if (!active) return;
        // A document nobody has asked about yet has no guide, which is the
        // normal starting state rather than something to report. Only the
        // status call may read a 404 this way — see the content fetch below.
        if (err instanceof ApiError && err.status === 404) {
          setRow(null);
          return;
        }
        setFetchError(
          err instanceof Error ? err.message : "Could not load the study guide"
        );
        failures += 1;
        timer = window.setTimeout(tick, Math.min(POLL_MS * 2 ** failures, MAX_RETRY_MS));
        return;
      }

      if (!active) return;
      failures = 0;
      setRow(status);
      setFetchError(null);
      // Someone who reloads while a guide is running never went through ask(),
      // so without this the "is the worker running?" hint — the one thing that
      // explains a guide stuck at pending — could never appear for them.
      if (!isSettled(status.status) && askedAt.current === null) {
        askedAt.current = new Date(status.created_at).getTime();
      }

      let contentFailed = false;
      if (status.status === "done") {
        // Its own try: a 404 here is not "nothing has been asked for". The
        // status call reports the newest row whatever its state, while
        // /content insists the newest row is done, so another member asking
        // for a fresh guide between the two calls 404s this one — and running
        // the branch above would blank the row and silently exit the loop.
        try {
          const full = await apiFetch<StudyGuideRow>(
            `/documents/${documentId}/study-guide/content`
          );
          if (!active) return;
          setGuide(full.guide);
        } catch (err) {
          if (!active) return;
          contentFailed = true;
          failures += 1;
          setFetchError(
            err instanceof Error ? err.message : "Could not load the study guide"
          );
        }
      }
      if (!isSettled(status.status)) timer = window.setTimeout(tick, POLL_MS);
      // A settled row normally ends the loop — there is no answer left to
      // change. But a `done` row whose content could not be fetched has an
      // answer this hook simply failed to collect, and ending there left
      // `guide` null with a reload as the only way out. Retry that one case,
      // on the same backoff the status call uses.
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
      // Refused here rather than by the API. The notes column is NOT NULL with
      // a min_length of 1, so an empty document comes back 422 — and a 422 is
      // the one status whose body FastAPI writes as a list of field errors,
      // which is the most apiFetch can turn into "notes: String should have at
      // least 1 character". True, and no use to someone who just wants to be
      // told the page is blank. Nothing is cleared on this path: the last
      // guide stays where it is, because no new one was started.
      if (notes.trim() === "") {
        setFetchError(
          "There are no notes to build a guide from yet — write something first."
        );
        return;
      }

      setAsking(true);
      setFetchError(null);
      try {
        // Cleared before the request, not after it returns: leaving the old
        // guide on screen while a new one is being written reads as though
        // nothing happened when someone presses the button a second time.
        setGuide(null);
        const created = await apiFetch<StudyGuideStatusRow>(
          `/documents/${documentId}/study-guide`,
          { method: "POST", body: JSON.stringify({ notes }) }
        );
        setRow(created);
        askedAt.current = Date.now();
        setPollToken((n) => n + 1);
      } catch (err) {
        setFetchError(
          err instanceof Error ? err.message : "Could not start a study guide"
        );
      } finally {
        setAsking(false);
      }
    },
    [documentId]
  );

  const running = row !== null && !isSettled(row.status);

  // A guide the worker gave up on is a failure the person who clicked has to
  // see. Nothing else renders row.error: the poll stops, the button re-enables
  // and `guide` stays null, so without this the click ends by putting the
  // toolbar back exactly as it was and the reason stays in the database.
  // Folded into one `error` so the caller has a single thing to render.
  const error =
    fetchError ??
    (row?.status === "failed"
      ? row.error ?? "The study guide could not be written."
      : null);

  const workerSuspect =
    running &&
    row.status === "pending" &&
    askedAt.current !== null &&
    Date.now() - askedAt.current > WORKER_SUSPECT_MS;

  return { row, guide, error, asking, running, workerSuspect, ask };
}
