import { useEffect, useRef, useState } from "react";

import { apiFetch } from "../lib/api";
import {
  SOURCE_ACCEPT,
  SOURCES_CHANGED_EVENT,
  attachSourceToChat,
  uploadSource,
} from "../lib/sources";
import type { Source } from "../lib/types";
import ConfirmDialog from "./ConfirmDialog";
import Orb from "./Orb";
import RowMenu from "./RowMenu";
import {
  IconAgent,
  IconDelete,
  IconDismiss,
  IconDocument,
  IconEmpty,
  IconFilePdf,
  IconRestart,
  IconUploadCloud,
} from "./Icon";

const ACCEPT = SOURCE_ACCEPT;
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

/** A file on its way up. Kept until the POST answers, and kept after a
 * failed one: the File is still in memory, so Retry can send it again
 * without asking for the file a second time. Once the POST succeeds the row
 * is replaced by the real source. */
interface Upload {
  key: string;
  file: File;
  state: "uploading" | "failed";
  error?: string;
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

function SourceMark({ filename }: { filename: string }) {
  const Mark = filename.toLowerCase().endsWith(".pdf") ? IconFilePdf : IconDocument;
  return <Mark className="source-icon" />;
}

export default function SourcesPanel({ spaceId }: { spaceId: string }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  /** Files over the zone, or 0 when nothing is being dragged. */
  const [dragCount, setDragCount] = useState(0);
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

  // A file dropped on the chat bar is uploaded without this panel knowing,
  // and the poll above has usually stopped by then.
  useEffect(() => {
    const onChanged = () => setPollToken((t) => t + 1);
    window.addEventListener(SOURCES_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(SOURCES_CHANGED_EVENT, onChanged);
  }, []);

  async function send(key: string, file: File) {
    try {
      // uploadSource announces the change, which restarts the poll above.
      const created = await uploadSource(spaceId, file);
      setUploads((prev) => prev.filter((u) => u.key !== key));
      // Shown immediately as "Queued" rather than waiting for the next poll,
      // so the file appears the instant the upload returns.
      setSources((prev) => [created, ...prev.filter((s) => s.id !== created.id)]);
    } catch (err) {
      const error = err instanceof Error ? err.message : "Upload failed";
      setUploads((prev) =>
        prev.map((u) => (u.key === key ? { ...u, state: "failed", error } : u))
      );
    }
  }

  // Each file goes up on its own, so one refused file does not take the rest
  // of a multi-file drop down with it.
  function upload(files: File[]) {
    const added: Upload[] = files.map((file) => ({
      key: `${file.name}-${file.lastModified}-${Math.random().toString(36).slice(2)}`,
      file,
      state: "uploading",
    }));
    setUploads((prev) => [...added, ...prev]);
    for (const u of added) void send(u.key, u.file);
  }

  function retryUpload(u: Upload) {
    setUploads((prev) =>
      prev.map((x) => (x.key === u.key ? { ...x, state: "uploading", error: undefined } : x))
    );
    void send(u.key, u.file);
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
    setDragCount(0);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length > 0) upload(files);
  }

  const uploading = uploads.some((u) => u.state === "uploading");

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
        className={`upload-zone${dragCount > 0 ? " is-dragging" : ""}`}
        onDragEnter={(e) => {
          e.preventDefault();
          dragDepth.current += 1;
          // How many items are coming is known before the drop, their names
          // are not — enough to say what is about to happen.
          setDragCount(Math.max(1, e.dataTransfer.items.length));
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={() => {
          dragDepth.current -= 1;
          if (dragDepth.current <= 0) setDragCount(0);
        }}
        onDrop={onDrop}
      >
        {/* Not disabled while uploading: each file is its own row now, so
            more can be added while the first ones are still going up. */}
        <input
          type="file"
          accept={ACCEPT}
          multiple
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length > 0) upload(files);
            e.target.value = "";
          }}
        />
        <IconUploadCloud className="upload-mark" size={20} />
        <span className="upload-label">
          {dragCount > 1
            ? `Drop ${dragCount} files`
            : dragCount === 1
              ? "Drop to upload"
              : uploading
                ? "Uploading…"
                : "Drop files or browse"}
        </span>
        <span className="upload-hint">PDF, PowerPoint, Markdown or text</span>
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
      {sources.length === 0 && uploads.length === 0 && !error && (
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
        {uploads.map((u) => (
          <li
            key={u.key}
            className={`source-card is-upload ${
              u.state === "failed" ? "source-failed" : "source-uploading"
            }`}
          >
            <SourceMark filename={u.file.name} />
            <div className="source-text">
              <span className="source-name" title={u.file.name}>
                {u.file.name}
              </span>
              <span className="source-meta">
                {u.state === "failed" ? (
                  <span className="source-dot" aria-hidden="true" />
                ) : (
                  <Orb activity="uploading" />
                )}
                {u.state === "failed"
                  ? "Upload failed"
                  : `Uploading · ${formatSize(u.file.size)}`}
              </span>
            </div>
            {u.state === "failed" ? (
              <div className="source-actions">
                <button type="button" className="source-retry" onClick={() => retryUpload(u)}>
                  <IconRestart size={13} />
                  Retry
                </button>
                <button
                  type="button"
                  className="icon-button is-small"
                  aria-label={`Dismiss ${u.file.name}`}
                  onClick={() => setUploads((prev) => prev.filter((x) => x.key !== u.key))}
                >
                  <IconDismiss size={14} />
                </button>
              </div>
            ) : null}
            {u.error && <p className="source-error">{u.error}</p>}
          </li>
        ))}

        {sources.map((s) => (
          <li key={s.id} className={`source-card source-${s.status}`}>
            <SourceMark filename={s.filename} />
            <div className="source-text">
              <span className="source-name" title={s.filename}>
                {s.filename}
              </span>
              <span className="source-meta">
                {/* The dot says a settled state; the orb says one still moving. */}
                {isSettled(s) ? (
                  <span className="source-dot" aria-hidden="true" />
                ) : (
                  <Orb activity={s.status === "pending" ? "queued" : "reading"} />
                )}
                {statusLabel(s)}
              </span>
            </div>

            {isSettled(s) && (
              <div className="source-actions">
                {/* Retry sits on the row rather than in the menu: it is the
                    one thing to do with a failed file, and the menu hid it. */}
                {s.status === "failed" && (
                  <button type="button" className="source-retry" onClick={() => void retry(s.id)}>
                    <IconRestart size={13} />
                    Retry
                  </button>
                )}

                {/* The same menu the document rail uses. A bare "Remove"
                    button inside the card was the loudest thing in it, which
                    is the wrong emphasis for the one action that cannot be
                    undone. */}
                <RowMenu
                  label={`Actions for ${s.filename}`}
                  items={[
                    // The way to make notes from a file that was uploaded
                    // earlier. Make notes is otherwise offered only for a
                    // file dropped on the chat bar, and a file already here
                    // had no route to it at all.
                    ...(s.status === "ready"
                      ? [
                          {
                            label: "Make notes in chat",
                            icon: <IconAgent size={14} />,
                            onSelect: () => attachSourceToChat({ id: s.id, filename: s.filename }),
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
              </div>
            )}

            {s.status === "failed" && s.error && <p className="source-error">{s.error}</p>}
          </li>
        ))}
      </ul>
    </aside>
  );
}
