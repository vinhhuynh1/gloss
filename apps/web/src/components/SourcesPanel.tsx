import { useEffect, useRef, useState } from "react";

import { apiFetch } from "../lib/api";
import type { Source } from "../lib/types";
import ConfirmDialog from "./ConfirmDialog";
import RowMenu from "./RowMenu";
import {
  IconDelete,
  IconDocument,
  IconEmpty,
  IconFilePdf,
  IconRestart,
  IconUploadCloud,
} from "./Icon";

const ACCEPT = ".pdf,.md,.markdown,.txt";
const POLL_MS = 2500;
/** Ceiling on the retry wait after a failed poll. Long enough that a stopped
 * API isn't hammered, short enough that the panel corrects itself on its own
 * once one comes back. */
const MAX_RETRY_MS = 30_000;

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

/** What the row says under the filename.
 *
 * Every state gets words. The card used to carry its status only as the
 * colour of a 6px dot, which cannot be read aloud, cannot be told apart by
 * roughly one man in twelve, and does not say what "amber" means even to
 * someone who can see it. */
function statusLabel(s: Source): string {
  switch (s.status) {
    case "ready": {
      const chunks = `${s.chunk_count} chunk${s.chunk_count === 1 ? "" : "s"}`;
      return s.byte_size === null
        ? chunks
        : `${chunks} · ${formatSize(s.byte_size)}`;
    }
    case "pending":
      return "Queued";
    case "processing":
      return "Processing…";
    case "failed":
      return "Failed";
  }
}

export default function SourcesPanel({ spaceId }: { spaceId: string }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  /** The source the remove dialog is asking about, if it is open. */
  const [pendingRemove, setPendingRemove] = useState<Source | null>(null);
  // Counted rather than a boolean: dragenter/dragleave also fire as the
  // pointer crosses the zone's own children, so a plain flag flickers off the
  // moment the cursor passes over the icon.
  const dragDepth = useRef(0);
  // Bumped by upload and retry to restart the poll below. Those actions put
  // work back in flight, and the loop has usually already exited by then —
  // without this the panel would sit on "Queued" until something else
  // remounted it.
  const [pollToken, setPollToken] = useState(0);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let failures = 0;

    // Polls only while something is actually in flight, and stops once every
    // source has settled. A permanent 2.5s poll would keep querying long
    // after there is any answer left to change — this panel is usually
    // looking at a finished list.
    async function tick() {
      try {
        const rows = await apiFetch<Source[]>(`/study-spaces/${spaceId}/sources`);
        if (!active) return;
        failures = 0;
        setSources(rows);
        setError(null);
        if (rows.some((s) => !isSettled(s))) {
          timer = window.setTimeout(tick, POLL_MS);
        }
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Could not load sources");
        // Keep trying rather than ending the loop here. A stopped API is
        // exactly when this panel is most wrong: it would otherwise sit on a
        // stale list of "Queued" rows for the life of the page, and still be
        // showing them after the worker had drained them. Backing off matters
        // because the common case is an API that stays down for minutes.
        failures += 1;
        timer = window.setTimeout(
          tick,
          Math.min(POLL_MS * 2 ** failures, MAX_RETRY_MS)
        );
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

  async function remove(source: Source) {
    try {
      await apiFetch(`/sources/${source.id}`, { method: "DELETE" });
      setSources((prev) => prev.filter((s) => s.id !== source.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  }

  const stalled = sources.some(
    (s) =>
      !isSettled(s) && Date.now() - new Date(s.uploaded_at).getTime() > WORKER_SUSPECT_MS
  );

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (uploading) return;
    const file = e.dataTransfer.files?.[0];
    if (file) void upload(file);
  }

  return (
    <aside className="sources-panel">
      <div className="panel-head">
        <h2>Source material</h2>
        {sources.length > 0 && (
          <span className="panel-count">{sources.length}</span>
        )}
      </div>

      {/* A dashed rectangle is the universal sign for "drop a file here", and
          this one only took clicks. Accepting the drop costs four handlers and
          removes the step where someone drags a file onto the panel, watches
          nothing happen, and goes looking for a button. */}
      <label
        className={`upload-zone${dragging ? " is-dragging" : ""}${
          uploading ? " is-busy" : ""
        }`}
        onDragEnter={(e) => {
          e.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={() => {
          dragDepth.current -= 1;
          if (dragDepth.current <= 0) setDragging(false);
        }}
        onDrop={onDrop}
      >
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
        <IconUploadCloud className="upload-mark" size={20} />
        <span className="upload-label">
          {uploading ? "Uploading…" : "Drop a file or browse"}
        </span>
        <span className="upload-hint">PDF, Markdown or text</span>
      </label>

      {error && <p className="error">{error}</p>}

      {stalled && (
        <p className="warning">
          Still queued. Is the ingestion worker running?
          <code>cd apps/agent-worker &amp;&amp; python worker.py</code>
        </p>
      )}

      {/* The explanation lives in the empty state rather than above the list
          for good. It is onboarding copy — read once, then two lines of grey
          sitting on top of the answer it was explaining. */}
      {sources.length === 0 && !error && (
        <div className="panel-empty">
          <IconEmpty className="panel-empty-mark" size={22} />
          <p className="panel-empty-title">No sources yet</p>
          <p className="panel-empty-body">
            Slides, chapters, handouts. The agent may only cite what's here.
          </p>
        </div>
      )}

      {/* Removing a source removes its chunks, so the agent silently loses
          the ability to cite it — nothing in the notes changes to say so. */}
      {pendingRemove && (
        <ConfirmDialog
          title={`Remove ${pendingRemove.filename}?`}
          body="Everything indexed from it goes too, and the agent can no longer cite it. This cannot be undone."
          confirmLabel="Remove source"
          onConfirm={() => {
            const target = pendingRemove;
            setPendingRemove(null);
            void remove(target);
          }}
          onCancel={() => setPendingRemove(null)}
        />
      )}

      <ul className="source-list">
        {sources.map((s) => {
          const isPdf = s.filename.toLowerCase().endsWith(".pdf");
          const Mark = isPdf ? IconFilePdf : IconDocument;
          return (
            <li key={s.id} className={`source-card source-${s.status}`}>
              <Mark className="source-icon" />
              <div className="source-text">
                <span className="source-name" title={s.filename}>
                  {s.filename}
                </span>
                <span className="source-meta">
                  <span className="source-dot" aria-hidden="true" />
                  {statusLabel(s)}
                </span>
              </div>

              {/* The same menu the document rail uses. A bare "Remove" button
                  inside the card was the loudest thing in it, which is the
                  wrong emphasis for the one action that cannot be undone. */}
              {isSettled(s) && (
                <RowMenu
                  label={`Actions for ${s.filename}`}
                  items={[
                    ...(s.status === "failed"
                      ? [
                          {
                            label: "Retry",
                            icon: <IconRestart size={14} />,
                            onSelect: () => void retry(s.id),
                          },
                        ]
                      : []),
                    {
                      label: "Remove",
                      icon: <IconDelete size={14} />,
                      destructive: true,
                      onSelect: () => setPendingRemove(s),
                    },
                  ]}
                />
              )}

              {s.status === "failed" && s.error && (
                <p className="source-error">{s.error}</p>
              )}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
