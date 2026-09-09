import { useEffect, useRef, useState } from "react";

import { apiFetch } from "../lib/api";
import type { Source } from "../lib/types";

const ACCEPT = ".pdf,.md,.markdown,.txt";
const POLL_MS = 2500;

/** How long a file may sit unprocessed before we stop blaming latency and
 * start suggesting the worker isn't running. Uploading is instant and
 * chunking a normal deck is seconds, so anything past this is a stopped
 * process — by far the most common local-setup mistake, and invisible from
 * the UI otherwise: the upload succeeded, so nothing looks broken. */
const WORKER_SUSPECT_MS = 25_000;

function formatSize(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isSettled(source: Source): boolean {
  return source.status === "ready" || source.status === "failed";
}

export default function SourcesPanel({ spaceId }: { spaceId: string }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // Bumped by upload and retry to restart the poll below. Those actions put
  // work back in flight, and the loop has usually already exited by then —
  // without this the panel would sit on "Queued" until something else
  // remounted it.
  const [pollToken, setPollToken] = useState(0);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;

    // Polls only while something is actually in flight, and stops once every
    // source has settled. A permanent 2.5s poll would keep querying long
    // after there is any answer left to change — this panel is usually
    // looking at a finished list.
    async function tick() {
      try {
        const rows = await apiFetch<Source[]>(`/study-spaces/${spaceId}/sources`);
        if (!active) return;
        setSources(rows);
        setError(null);
        if (rows.some((s) => !isSettled(s))) {
          timer = window.setTimeout(tick, POLL_MS);
        }
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Could not load sources");
      }
    }

    void tick();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [spaceId, pollToken]);

  async function upload(file: File) {
    setUploading(true);
    setError(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const created = await apiFetch<Source>(`/study-spaces/${spaceId}/sources`, {
        method: "POST",
        body,
      });
      // Shown immediately as "Queued" rather than waiting for the next poll,
      // so the file appears the instant the upload returns.
      setSources((prev) => [created, ...prev]);
      setPollToken((t) => t + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function retry(id: string) {
    try {
      const updated = await apiFetch<Source>(`/sources/${id}/retry`, {
        method: "POST",
      });
      setSources((prev) => prev.map((s) => (s.id === id ? updated : s)));
      setPollToken((t) => t + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Retry failed");
    }
  }

  async function remove(id: string, filename: string) {
    // Deleting a source deletes its chunks, so the agent silently loses the
    // ability to cite it. Cheap confirm for an action nothing can undo.
    if (!window.confirm(`Remove ${filename} and everything indexed from it?`)) return;
    try {
      await apiFetch(`/sources/${id}`, { method: "DELETE" });
      setSources((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  }

  const stalled = sources.some(
    (s) =>
      !isSettled(s) && Date.now() - new Date(s.uploaded_at).getTime() > WORKER_SUSPECT_MS
  );

  return (
    <aside className="sources-panel">
      <h2>Source material</h2>
      <p className="muted">
        Slides, chapters, handouts. The agent may only cite what's here.
      </p>

      <label className="upload-button">
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPT}
          disabled={uploading}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
        />
        {uploading ? "Uploading…" : "Upload a file"}
      </label>

      {error && <p className="error">{error}</p>}

      {stalled && (
        <p className="warning">
          Still queued. Is the ingestion worker running?
          <code>cd apps/agent-worker &amp;&amp; python worker.py</code>
        </p>
      )}

      {sources.length === 0 && !error && (
        <p className="muted">Nothing uploaded yet.</p>
      )}

      <ul className="source-list">
        {sources.map((s) => (
          <li key={s.id} className={`source-card source-${s.status}`}>
            <span className="source-name" title={s.filename}>
              {s.filename}
            </span>
            <span className="source-meta">
              {s.status === "ready" && (
                <>
                  {s.chunk_count} chunk{s.chunk_count === 1 ? "" : "s"}
                  {s.byte_size !== null && ` · ${formatSize(s.byte_size)}`}
                </>
              )}
              {s.status === "pending" && "Queued"}
              {s.status === "processing" && "Processing…"}
              {s.status === "failed" && "Failed"}
            </span>
            {s.status === "failed" && s.error && (
              <p className="source-error">{s.error}</p>
            )}
            <div className="source-actions">
              {s.status === "failed" && (
                <button onClick={() => void retry(s.id)}>Retry</button>
              )}
              {isSettled(s) && (
                <button onClick={() => void remove(s.id, s.filename)}>Remove</button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
}
