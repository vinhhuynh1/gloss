/**
 * The space chat, docked to the bottom of the page.
 *
 * A bar that is always there and a thread that opens above it. The bar is the
 * whole affordance: someone with a question should not have to find a button
 * that opens a panel that contains the place to type. Focusing it opens the
 * thread, and Escape or the close button folds it away again.
 *
 * Mounted by SpacePage rather than by the per-document Workspace. The thread
 * belongs to the space, and a Workspace remounts on every document switch —
 * which would close the chat and drop its scroll position each time.
 *
 * Files can be dropped on the dock or attached from the bar. They become
 * sources of the space like any upload, and while they sit in the bar the
 * one-click action is "Make notes from" them — for the person who has the
 * slides and does not yet know what to write down. Anything typed alongside
 * becomes the instructions ("focus on the exam topics").
 *
 * "Make notes" runs in one of two modes, remembered per browser. Plan first
 * answers with an outline to trim and reorder, and the notes are written to
 * the approved outline; auto writes the notes at once. Either way the notes
 * then go into the document they were asked for without a click — from the
 * asker's browser, after claiming them through the API so that a second tab,
 * or a second person, cannot insert the same notes twice.
 *
 * Messages render a deliberately small subset of markdown — "## " headings,
 * "- " bullets and their indents, **bold** and [n] citations — which is
 * exactly what the prompts in apps/agent-worker/prompts.py allow. Built as
 * elements, never as HTML: the body is model output and goes nowhere near
 * innerHTML.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DragEvent, FormEvent, KeyboardEvent, ReactNode } from "react";

import {
  IconAgent,
  IconAttach,
  IconDismiss,
  IconDocument,
  IconMoveDown,
  IconMoveUp,
  IconSend,
} from "./Icon";
import Orb from "./Orb";
import {
  ATTACH_SOURCE_EVENT,
  SOURCE_ACCEPT,
  uploadSource,
  type AttachSourceDetail,
} from "../lib/sources";
import { useChat } from "../lib/useChat";
import type { ChatCitation, ChatMessage, NotesMode, OutlineSection } from "../lib/types";

const MODE_KEY = "gloss.notesMode";

/** The last mode this browser used. Wrapped: storage throws in some private
 * windows, and the default is a fine answer then. */
function loadMode(): NotesMode {
  try {
    return localStorage.getItem(MODE_KEY) === "auto" ? "auto" : "plan";
  } catch {
    return "plan";
  }
}

function saveMode(mode: NotesMode) {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Remembering is a convenience; not remembering is fine.
  }
}

/** Matches MAX_CHAT_CHARS in apps/api/schemas.py. */
const MAX_CHARS = 2000;

/** How long after the last keystroke the chat bar stops listening. Long
 * enough to bridge the pause between words, short enough that it has settled
 * by the time the hand reaches for Enter. */
const TYPING_IDLE_MS = 1200;

/** Matches MAX_NOTES_SOURCES and MAX_NOTES_CHARS in apps/api/schemas.py. */
const MAX_NOTES_FILES = 5;
const MAX_EXISTING_NOTES_CHARS = 40_000;

/** Within this many pixels of the bottom counts as "reading the latest", and
 * new text keeps the thread pinned there. Further up, someone is reading back
 * and must not be yanked down by a streaming answer. */
const PIN_SLACK_PX = 48;

const ACCEPTED = SOURCE_ACCEPT.split(",");

/** A file in the bar, from the moment it is dropped. */
interface Attachment {
  key: string;
  name: string;
  state: "uploading" | "uploaded" | "failed";
  sourceId?: string;
  error?: string;
}

/** A progress line the worker writes while it reads a long file, before the
 * notes themselves start arriving — "_Reading the material, part 2 of 3…_". */
function statusLine(m: ChatMessage): string | null {
  if (m.status !== "processing") return null;
  const match = /^_(.+)_$/.exec(m.body.trim());
  return match ? match[1] : null;
}

/** "8s", "1m 05s". */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const sec = String(total % 60).padStart(2, "0");
  return `${m}m ${sec}s`;
}

/** Seconds since `from`, ticking once a second while `running`. The answer
 * rows come from polling, so without a clock of its own the counter would
 * only move when a poll lands. */
function useElapsed(from: string, running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  return now - new Date(from).getTime();
}

/** A heading for an inserted answer: the question it answers, on one line
 * and short enough to read in the outline. Answers are written without
 * headings, so without this an inserted answer never shows in the outline. */
function titleFromQuestion(question: string): string {
  const line = question.trim().split("\n")[0].trim();
  if (line.length <= 80) return line;
  const cut = line.slice(0, 80);
  const space = cut.lastIndexOf(" ");
  return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function sourceLabel(c: ChatCitation): string {
  return [c.filename, c.page_ref].filter(Boolean).join(" · ");
}

/** **bold**, *italic* and [n], within one line of text. Italic is not in the
 * prompts' format, but see EMPHASIS_RE in lib/notesToDoc.ts. */
function renderInline(
  text: string,
  citations: Map<number, ChatCitation>,
  onCite: (n: number) => void,
  key: string
): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /\*\*(.+?)\*\*|\*([^*\s](?:[^*]*[^*\s])?)\*|\[(\d{1,4})\]/g;
  let last = 0;
  let i = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    if (match[1] !== undefined) {
      out.push(<strong key={`${key}-b${i}`}>{match[1]}</strong>);
    } else if (match[2] !== undefined) {
      out.push(<em key={`${key}-i${i}`}>{match[2]}</em>);
    } else {
      const n = Number(match[3]);
      const c = citations.get(n);
      // A marker with no citation behind it is a number still streaming in,
      // before the worker has matched it to an excerpt. Shown as plain text
      // until then rather than as a chip that opens nothing.
      out.push(
        c ? (
          <button
            key={`${key}-c${i}`}
            type="button"
            className="chat-cite"
            title={sourceLabel(c)}
            onClick={() => onCite(n)}
          >
            {n}
          </button>
        ) : (
          match[0]
        )
      );
    }
    last = at + match[0].length;
    i += 1;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function RichText({
  body,
  citations,
  onCite,
}: {
  body: string;
  citations: ChatCitation[];
  onCite: (n: number) => void;
}) {
  const byN = new Map(citations.map((c) => [c.n, c]));
  const out: ReactNode[] = [];
  // Consecutive bullets are gathered into one list. Nesting is drawn as an
  // indent on the item rather than as nested lists: this is a preview in a
  // narrow panel, and the document gets the real structure on insert.
  let bullets: { level: number; text: string }[] = [];
  const flush = () => {
    if (bullets.length === 0) return;
    const k = out.length;
    out.push(
      <ul key={k}>
        {bullets.map((b, bi) => (
          <li key={bi} className={b.level ? `is-l${Math.min(b.level, 3)}` : undefined}>
            {renderInline(b.text, byN, onCite, `${k}-${bi}`)}
          </li>
        ))}
      </ul>
    );
    bullets = [];
  };

  body.split("\n").forEach((raw, li) => {
    const line = raw.replace(/\s+$/, "");
    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      bullets.push({ level: Math.floor(bullet[1].length / 2), text: bullet[2] });
      return;
    }
    flush();
    if (line.trim() === "") return;
    // "#" is accepted as well as "##": see HEADING_RE in lib/notesToDoc.ts.
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      out.push(
        <p key={`h${li}`} className={heading[1].length <= 2 ? "chat-h2" : "chat-h3"}>
          {renderInline(heading[2], byN, onCite, `h${li}`)}
        </p>
      );
    } else {
      out.push(<p key={`p${li}`}>{renderInline(line, byN, onCite, `p${li}`)}</p>);
    }
  });
  flush();
  return <>{out}</>;
}

/** What the notes' insert row should say, worked out by ChatDock, which knows
 * who is looking and which document is open. */
export interface InsertState {
  /** Auto or plan notes waiting for the asker to open the document they were
   * made for; they go in by themselves when it is. */
  waitingForDocument: boolean;
  error: string | null;
}

/**
 * A plan for notes, editable until someone approves it.
 *
 * The edits are local to whoever is looking — the plan is a proposal, not a
 * shared document, and two people trimming it at once would only fight. What
 * is approved travels with the request, and the approved plan turns
 * read-only for everyone.
 */
function PlanCard({
  message,
  busy,
  onApprove,
}: {
  message: ChatMessage;
  busy: boolean;
  onApprove: (plan: ChatMessage, outline: OutlineSection[]) => void;
}) {
  const [items, setItems] = useState(() =>
    (message.outline ?? []).map((s, i) => ({ ...s, key: i, keep: true }))
  );
  const approved = message.applied_at !== null;
  const kept = items.filter((s) => s.keep && s.heading.trim() !== "");

  const move = (index: number, by: -1 | 1) =>
    setItems((prev) => {
      const next = [...prev];
      const [item] = next.splice(index, 1);
      next.splice(index + by, 0, item);
      return next;
    });

  if (items.length === 0) {
    return (
      <div className="chat-body">
        <p>{message.body}</p>
      </div>
    );
  }

  return (
    <div className={`chat-plan${approved ? " is-approved" : ""}`}>
      <p className="chat-plan-lead">
        {approved
          ? "Plan approved. The notes are below."
          : "Here's the plan. Untick what you don't need, reorder or rename sections, then write the notes."}
      </p>
      <ol className="chat-plan-list">
        {items.map((s, i) => (
          <li key={s.key} className={s.keep ? undefined : "is-dropped"}>
            <input
              type="checkbox"
              checked={s.keep}
              disabled={approved}
              aria-label={`Include “${s.heading}”`}
              onChange={(e) =>
                setItems((prev) =>
                  prev.map((x) => (x.key === s.key ? { ...x, keep: e.target.checked } : x))
                )
              }
            />
            <div className="chat-plan-text">
              <input
                className="chat-plan-heading"
                value={s.heading}
                disabled={approved || !s.keep}
                maxLength={200}
                aria-label="Section heading"
                onChange={(e) =>
                  setItems((prev) =>
                    prev.map((x) => (x.key === s.key ? { ...x, heading: e.target.value } : x))
                  )
                }
              />
              {s.summary && <span className="chat-plan-summary">{s.summary}</span>}
            </div>
            {!approved && (
              <span className="chat-plan-move">
                <button
                  type="button"
                  className="icon-button is-small"
                  aria-label="Move up"
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  <IconMoveUp size={14} />
                </button>
                <button
                  type="button"
                  className="icon-button is-small"
                  aria-label="Move down"
                  disabled={i === items.length - 1}
                  onClick={() => move(i, 1)}
                >
                  <IconMoveDown size={14} />
                </button>
              </span>
            )}
          </li>
        ))}
      </ol>
      {!approved && (
        <div className="chat-notes-actions">
          <button
            type="button"
            className="with-icon"
            disabled={busy || kept.length === 0}
            onClick={() =>
              onApprove(
                message,
                kept.map(({ heading, summary, pages }) => ({ heading: heading.trim(), summary, pages }))
              )
            }
          >
            <IconAgent size={14} />
            Write notes
          </button>
          <span className="muted">
            {kept.length} of {items.length} section{items.length === 1 ? "" : "s"}
          </span>
        </div>
      )}
    </div>
  );
}

function Answer({
  message,
  canInsert,
  insertState,
  busy,
  onRetry,
  onInsert,
  onInsertAgain,
  onApprove,
}: {
  message: ChatMessage;
  canInsert: boolean;
  insertState: InsertState;
  busy: boolean;
  onRetry: (id: string) => void;
  /** First insert: claims the notes, then inserts. */
  onInsert: (m: ChatMessage) => void;
  /** A deliberate second copy, e.g. into another document. No claim. */
  onInsertAgain: (m: ChatMessage) => void;
  onApprove: (plan: ChatMessage, outline: OutlineSection[]) => void;
}) {
  const [openCite, setOpenCite] = useState<number | null>(null);
  const citations = message.citations ?? [];
  const shown = citations.find((c) => c.n === openCite) ?? null;
  const toggle = (n: number) => setOpenCite((cur) => (cur === n ? null : n));
  const isNotes = message.kind === "notes";
  const isPlan = message.kind === "plan";
  const progress = statusLine(message);
  const done = message.status === "done" && message.body !== "";
  const running = message.status === "pending" || message.status === "processing";
  const elapsed = useElapsed(message.created_at, running);
  const took =
    message.status === "done" && message.finished_at
      ? new Date(message.finished_at).getTime() - new Date(message.created_at).getTime()
      : null;

  let content: ReactNode;
  if (message.status === "failed") {
    content = (
      <div className="chat-failed">
        <p className="error">{message.error ?? "The answer failed."}</p>
        <button type="button" className="link-button" onClick={() => onRetry(message.id)}>
          Try again
        </button>
      </div>
    );
  } else if (message.body === "" || progress) {
    // 'pending' covers waiting for the worker and waiting for uploads in this
    // space to finish processing; the worker holds an answer back until they
    // have, so it is never answered from half the material.
    const activity =
      message.status === "pending" ? "queued" : isNotes || isPlan ? "reading" : "thinking";
    content = (
      <p className="chat-thinking" aria-live="polite">
        <Orb activity={activity} />
        {progress ??
          (message.status === "pending"
            ? "Waiting to answer…"
            : isNotes || isPlan
              ? "Reading the files…"
              : "Thinking…")}
        <span className="chat-elapsed">{formatDuration(elapsed)}</span>
      </p>
    );
  } else if (isPlan && done) {
    content = <PlanCard message={message} busy={busy} onApprove={onApprove} />;
  } else {
    content = (
      <div
        className={`chat-body${isNotes ? " is-notes" : ""}${
          message.status === "processing" ? " is-streaming" : ""
        }`}
      >
        <RichText body={message.body} citations={citations} onCite={toggle} />
        {message.status === "processing" && <Orb activity="writing" className="chat-writing" />}
        {message.status === "processing" && (
          <span className="chat-elapsed">{formatDuration(elapsed)}</span>
        )}
      </div>
    );
  }

  return (
    <div className="chat-message is-assistant">
      <IconAgent className="chat-message-mark" />
      <div className="chat-message-main">
        {content}
        {took !== null && (
          <p className="chat-meta">
            <time dateTime={message.finished_at ?? undefined}>
              {new Date(message.finished_at!).toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
              })}
            </time>
            {" · "}
            {isPlan ? "planned" : isNotes ? "written" : "answered"} in {formatDuration(took)}
          </p>
        )}
        {/* A notes answer can cite forty pages; a chip for each would bury
            the notes. The inline numbers still open their excerpt. */}
        {done && !isNotes && !isPlan && citations.length > 0 && (
          <div className="chat-sources">
            {citations.map((c) => (
              <button
                key={c.n}
                type="button"
                className={`chat-source${openCite === c.n ? " is-open" : ""}`}
                aria-expanded={openCite === c.n}
                onClick={() => toggle(c.n)}
              >
                <span className="chat-source-n">{c.n}</span>
                <span className="chat-source-label">{sourceLabel(c)}</span>
              </button>
            ))}
          </div>
        )}
        {shown && (
          <blockquote className="chat-excerpt">
            <span className="chat-excerpt-label">{sourceLabel(shown)}</span>
            {shown.excerpt}
          </blockquote>
        )}
        {done && message.kind === "answer" && citations.length > 0 && (
          <div className="chat-notes-actions">
            {/* The same button notes get, not a link: it is the same act, and
                two looks for one action read as two different things. */}
            <button
              type="button"
              className="with-icon"
              disabled={!canInsert}
              title={canInsert ? undefined : "Open a document to add this answer to it"}
              onClick={() => onInsertAgain(message)}
            >
              <IconDocument size={14} />
              Insert into notes
            </button>
            {insertState.error && <span className="error">{insertState.error}</span>}
          </div>
        )}
        {done && isNotes && (
          <div className="chat-notes-actions">
            {message.applied_at ? (
              <>
                <span className="chat-notes-done">Added to the document</span>
                <button
                  type="button"
                  className="link-button"
                  disabled={!canInsert}
                  onClick={() => onInsertAgain(message)}
                >
                  Insert again here
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="with-icon"
                  disabled={!canInsert}
                  title={canInsert ? undefined : "Open a document to add these notes to it"}
                  onClick={() => onInsert(message)}
                >
                  <IconDocument size={14} />
                  {insertState.waitingForDocument ? "Insert here instead" : "Insert into notes"}
                </button>
                {insertState.waitingForDocument && (
                  <span className="muted">
                    These go in by themselves when you open the document they were made for.
                  </span>
                )}
              </>
            )}
            {insertState.error && <span className="error">{insertState.error}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

export default function ChatDock({
  spaceId,
  currentUserId,
  canInsert,
  openDocumentId,
  readNotes,
  onInsertNotes,
}: {
  spaceId: string;
  currentUserId: string | undefined;
  /** Whether a document is open to insert notes into. */
  canInsert: boolean;
  /** The document the open editor belongs to — which notes are asked for,
   * and which auto and plan notes wait for before inserting themselves. */
  openDocumentId: string | null;
  /** The open document's text, so notes can skip what it already says. */
  readNotes: () => string | null;
  /** Returns an error message, or null once the notes are in the document.
   * `title` heads content that has no heading of its own. */
  onInsertNotes: (m: ChatMessage, title?: string) => string | null;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [typing, setTyping] = useState(false);
  const typingTimer = useRef<number | undefined>(undefined);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);
  const [mode, setMode] = useState<NotesMode>(loadMode);
  const [insertErrors, setInsertErrors] = useState<Record<string, string>>({});
  const {
    messages,
    loaded,
    hasEarlier,
    loadingEarlier,
    sending,
    error,
    ask,
    retry,
    loadEarlier,
    claimApply,
    releaseApply,
  } = useChat(spaceId, open);

  const setInsertError = (id: string, message: string | null) =>
    setInsertErrors((prev) => {
      const next = { ...prev };
      if (message) next[id] = message;
      else delete next[id];
      return next;
    });

  /** Claim, then insert; give the claim back if the insert fails. */
  const insertClaimed = useCallback(
    async (m: ChatMessage) => {
      setInsertError(m.id, null);
      let claimed: boolean;
      try {
        claimed = await claimApply(m.id);
      } catch (err) {
        setInsertError(m.id, err instanceof Error ? err.message : "Could not add the notes");
        return;
      }
      // Someone else — or this person's other tab — got there first. The
      // row now says "Added", which is the truth.
      if (!claimed) return;
      const problem = onInsertNotes(m);
      if (problem) {
        setInsertError(m.id, problem);
        await releaseApply(m.id);
      }
    },
    [claimApply, releaseApply, onInsertNotes]
  );

  const insertAgain = (m: ChatMessage) => {
    const question = m.kind === "answer" ? messages.find((q) => q.id === m.reply_to) : undefined;
    setInsertError(
      m.id,
      onInsertNotes(m, question ? titleFromQuestion(question.body) : undefined)
    );
  };

  // Auto and plan notes go into their document without a click, from the
  // asker's browser only, and only while that document is the one open —
  // never into whichever happens to be open when they finish. Each is tried
  // once per page load; the claim stops every other attempt anywhere.
  const attempted = useRef(new Set<string>());
  useEffect(() => {
    if (!canInsert || !openDocumentId || !currentUserId) return;
    for (const m of messages) {
      if (m.kind !== "notes" || m.status !== "done" || !m.mode || m.applied_at) continue;
      if (m.requested_by !== currentUserId || m.document_id !== openDocumentId) continue;
      if (attempted.current.has(m.id)) continue;
      attempted.current.add(m.id);
      void insertClaimed(m);
    }
  }, [messages, canInsert, openDocumentId, currentUserId, insertClaimed]);

  const approvePlan = (plan: ChatMessage, outline: OutlineSection[]) => {
    pinned.current = true;
    void ask("Write the notes from this plan.", undefined, {
      planId: plan.id,
      outline,
      existing: (readNotes() ?? "").slice(0, MAX_EXISTING_NOTES_CHARS),
    });
  };

  const thread = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const pinned = useRef(true);
  // Counted rather than a boolean, as in SourcesPanel: dragenter and
  // dragleave also fire as the pointer crosses the dock's own children.
  const dragDepth = useRef(0);

  // Streaming grows the last message in place, so "new content" is not only
  // a new row. Any change to the list re-pins if the reader was at the end.
  useLayoutEffect(() => {
    const el = thread.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  const ready = attachments.filter((a) => a.state === "uploaded" && a.sourceId);
  const uploading = attachments.some((a) => a.state === "uploading");

  const placeholder =
    ready.length > 0
      ? "Ask about these files, or add instructions for the notes…"
      : "Ask about your sources…";

  // Grow with the text up to the CSS max-height, then scroll inside. The
  // placeholder is measured too: the longer one shown with files attached can
  // wrap on a narrow screen, and an empty field is sized by it.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft, placeholder]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // A different space starts with an empty bar.
  useEffect(() => {
    setAttachments([]);
    setDropError(null);
  }, [spaceId]);

  // "Make notes in chat" from the Sources panel: the file is already
  // uploaded, so it joins the bar ready, once, and the chat opens on it.
  useEffect(() => {
    const onAttach = (e: Event) => {
      const { id, filename } = (e as CustomEvent<AttachSourceDetail>).detail;
      setAttachments((prev) =>
        prev.some((a) => a.sourceId === id)
          ? prev
          : [...prev, { key: `source-${id}`, name: filename, state: "uploaded", sourceId: id }]
      );
      setOpen(true);
      input.current?.focus();
    };
    window.addEventListener(ATTACH_SOURCE_EVENT, onAttach);
    return () => window.removeEventListener(ATTACH_SOURCE_EVENT, onAttach);
  }, []);

  function addFiles(files: File[]) {
    setDropError(null);
    const unsupported = files.filter((f) => !ACCEPTED.includes(extensionOf(f.name)));
    if (unsupported.length) {
      setDropError(
        `${unsupported.map((f) => f.name).join(", ")} can't be added. Use PDF, PowerPoint (.pptx), Markdown or text.`
      );
    }
    for (const file of files.filter((f) => ACCEPTED.includes(extensionOf(f.name)))) {
      const key = `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`;
      setAttachments((prev) => [...prev, { key, name: file.name, state: "uploading" }]);
      uploadSource(spaceId, file).then(
        (source) =>
          setAttachments((prev) =>
            prev.map((a) => (a.key === key ? { ...a, state: "uploaded", sourceId: source.id } : a))
          ),
        (err: unknown) =>
          setAttachments((prev) =>
            prev.map((a) =>
              a.key === key
                ? { ...a, state: "failed", error: err instanceof Error ? err.message : "Upload failed" }
                : a
            )
          )
      );
    }
    setOpen(true);
  }


  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;
    setOpen(true);
    pinned.current = true;
    if (await ask(body)) setDraft("");
  }

  async function makeNotes() {
    if (ready.length === 0 || uploading || sending) return;
    const chosen = ready.slice(0, MAX_NOTES_FILES);
    const names = chosen.map((a) => a.name);
    // Whatever is typed is the instructions; with nothing typed, the request
    // itself is what shows in the thread.
    const body =
      draft.trim() ||
      `Make notes from ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`}.`;
    const existing = (readNotes() ?? "").slice(0, MAX_EXISTING_NOTES_CHARS);
    setOpen(true);
    pinned.current = true;
    const ok = await ask(body, {
      sourceIds: chosen.map((a) => a.sourceId!),
      existing,
      mode,
      documentId: openDocumentId,
    });
    if (ok) {
      setDraft("");
      setAttachments((prev) => prev.filter((a) => !chosen.includes(a)));
    }
  }

  // The timer outlives the keystroke that set it; clear it on unmount so it
  // cannot set state on a dock that has gone.
  useEffect(() => () => window.clearTimeout(typingTimer.current), []);

  function onDraftChange(value: string) {
    setDraft(value);
    setTyping(value.trim() !== "");
    window.clearTimeout(typingTimer.current);
    typingTimer.current = window.setTimeout(() => setTyping(false), TYPING_IDLE_MS);
  }

  function onInputKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter is a new line — the chat convention, and the
    // one thing people try first. Not while an IME is composing a character.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  }

  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes("Files");

  const makeNotesLabel =
    ready.length === 1
      ? `Make notes from ${ready[0].name}`
      : `Make notes from ${Math.min(ready.length, MAX_NOTES_FILES)} files`;

  return (
    <div
      className={`chat-dock${open ? " is-open" : ""}${dragging ? " is-dragging" : ""}`}
      onDragEnter={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (hasFiles(e)) e.preventDefault();
      }}
      onDragLeave={() => {
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) setDragging(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        addFiles(Array.from(e.dataTransfer.files));
      }}
    >
      {open && (
        <section className="chat-panel" aria-label="Space chat">
          <header className="chat-panel-head">
            <IconAgent className="chat-panel-mark" />
            <div className="chat-panel-title">
              <span>Ask your sources</span>
              <span className="chat-panel-sub">Everyone in this space sees this chat</span>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label="Close chat"
              onClick={() => setOpen(false)}
            >
              <IconDismiss />
            </button>
          </header>

          <div
            className="chat-thread"
            ref={thread}
            onScroll={(e) => {
              const el = e.currentTarget;
              pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_SLACK_PX;
            }}
          >
            {hasEarlier && (
              <button
                type="button"
                className="link-button chat-earlier"
                disabled={loadingEarlier}
                onClick={() => {
                  pinned.current = false;
                  void loadEarlier();
                }}
              >
                {loadingEarlier ? (
                  <>
                    <Orb activity="busy" />
                    Loading…
                  </>
                ) : (
                  "Show earlier messages"
                )}
              </button>
            )}

            {loaded && messages.length === 0 && (
              <div className="chat-empty">
                <p>Ask anything about the material in Sources.</p>
                <p className="muted">
                  Answers come only from what your group uploaded, with a
                  citation you can check for every point. Drop slides or
                  readings here to make notes from them.
                </p>
              </div>
            )}

            {messages.map((m) =>
              m.role === "user" ? (
                <div key={m.id} className="chat-message is-user">
                  <span className="chat-author">
                    {m.author_id && m.author_id === currentUserId
                      ? "You"
                      : m.author_name ?? "A former member"}
                  </span>
                  <p className="chat-question">{m.body}</p>
                </div>
              ) : (
                <Answer
                  key={m.id}
                  message={m}
                  canInsert={canInsert}
                  busy={sending}
                  insertState={{
                    waitingForDocument:
                      m.kind === "notes" &&
                      m.mode !== null &&
                      m.requested_by === currentUserId &&
                      m.document_id !== null &&
                      m.document_id !== openDocumentId,
                    error: insertErrors[m.id] ?? null,
                  }}
                  onRetry={(id) => void retry(id)}
                  onInsert={(msg) => void insertClaimed(msg)}
                  onInsertAgain={insertAgain}
                  onApprove={approvePlan}
                />
              )
            )}
          </div>

          {error && <p className="error chat-error">{error}</p>}
        </section>
      )}

      <form className="chat-bar" onSubmit={(e) => void submit(e)}>
        {dragging && (
          <div className="chat-drop" aria-hidden="true">
            Drop to add to Sources and make notes
          </div>
        )}

        {(attachments.length > 0 || dropError) && (
          <div className="chat-attachments">
            {attachments.map((a) => (
              <span
                key={a.key}
                className={`chat-attachment is-${a.state}`}
                title={a.error ?? a.name}
              >
                <IconDocument size={14} />
                <span className="chat-attachment-name">{a.name}</span>
                <span className="chat-attachment-state">
                  {a.state === "uploading" && <Orb activity="uploading" />}
                  {a.state === "uploading" ? "Uploading…" : a.state === "failed" ? "Failed" : ""}
                </span>
                <button
                  type="button"
                  className="icon-button is-small"
                  aria-label={`Remove ${a.name} from this message`}
                  onClick={() => setAttachments((prev) => prev.filter((x) => x.key !== a.key))}
                >
                  <IconDismiss size={12} />
                </button>
              </span>
            ))}
            {ready.length > 0 && (
              <button
                type="button"
                className="chat-make-notes with-icon"
                disabled={uploading || sending}
                onClick={() => void makeNotes()}
              >
                <IconAgent size={14} />
                {makeNotesLabel}
              </button>
            )}
            {ready.length > 0 && (
              <div className="chat-mode" role="radiogroup" aria-label="How to make the notes">
                {(
                  [
                    ["plan", "Plan first", "Propose an outline to review, then write the notes"],
                    ["auto", "Auto", "Write the notes straight into the document"],
                  ] as const
                ).map(([value, label, hint]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={mode === value}
                    title={hint}
                    className={mode === value ? "is-on" : undefined}
                    onClick={() => {
                      setMode(value);
                      saveMode(value);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            {dropError && <span className="error chat-drop-error">{dropError}</span>}
          </div>
        )}

        <div className="chat-bar-row">
          <button
            type="button"
            className="icon-button chat-attach"
            aria-label="Add files"
            title="Add files to Sources"
            onClick={() => filePicker.current?.click()}
          >
            <IconAttach />
          </button>
          <input
            ref={filePicker}
            type="file"
            accept={SOURCE_ACCEPT}
            multiple
            hidden
            onChange={(e) => {
              addFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          <textarea
            ref={input}
            rows={1}
            value={draft}
            maxLength={MAX_CHARS}
            placeholder={placeholder}
            aria-label="Ask about your sources"
            onFocus={() => setOpen(true)}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={onInputKey}
          />
          {/* A fixed slot, filled only while you type, so the textarea does
              not shift sideways every time the orb comes and goes. */}
          <span className="chat-listening">
            {typing && <Orb activity="listening" />}
          </span>
          <button
            type="submit"
            className="chat-send"
            aria-label="Send"
            disabled={!draft.trim() || sending}
          >
            <IconSend />
          </button>
        </div>
      </form>
    </div>
  );
}
