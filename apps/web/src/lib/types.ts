/**
 * Wire types, mirroring apps/api/schemas.py.
 *
 * Duplicated from packages/shared/types.ts rather than imported, matching the
 * note there — the monorepo still has no cross-package build step.
 */
export interface StudySpace {
  id: string;
  course_name: string;
  created_by: string;
  created_at: string;
}

export interface SpaceDocument {
  id: string;
  study_space_id: string;
  title: string;
  updated_at: string;
  created_at: string;
}

export interface Member {
  user_id: string;
  email: string;
  name: string;
  role: "owner" | "member";
  joined_at: string;
}

/**
 * Where a suggestion sits in the document: two serialized Yjs relative
 * positions plus the text as it read when the check was requested. See
 * lib/anchors.ts. `from`/`to` are absent on suggestions made from the agent
 * CLI, which has no view of the document.
 */
export interface Anchor {
  from?: unknown;
  to?: unknown;
  quote?: string;
  source?: string;
}

export type SuggestionType = "citation" | "contradiction" | "gap_fill";

export interface Suggestion {
  id: string;
  document_id: string;
  type: SuggestionType;
  anchor: Anchor;
  proposed_text: string;
  source_chunk_id: string | null;
  /** Snapshotted from the cited chunk when the suggestion was written, so
   * the citation survives re-chunking. */
  source_filename: string | null;
  source_page_ref: string | null;
  source_excerpt: string | null;
  status: "pending" | "accepted" | "rejected";
  created_at: string;
}

/** One "check this passage" request. The worker moves it through these; the
 * API only ever creates it as pending. See apps/agent-worker/worker.py. */
export type AgentRequestStatus = "pending" | "processing" | "done" | "failed";

export interface AgentRequest {
  id: string;
  document_id: string;
  passage: string;
  status: AgentRequestStatus;
  attempts: number;
  error: string | null;
  /** Set once done. "none" means the agent checked and found nothing to flag. */
  result_type: SuggestionType | "none" | null;
  suggestion_id: string | null;
  created_at: string;
  finished_at: string | null;
}

/** Ingestion state of one uploaded file. `ready` is the only state in which
 * the agent can retrieve against it — see apps/agent-worker/worker.py. */
export type SourceStatus = "pending" | "processing" | "ready" | "failed";

export interface Source {
  id: string;
  study_space_id: string;
  filename: string;
  uploaded_by: string;
  uploaded_at: string;
  status: SourceStatus;
  content_type: string | null;
  byte_size: number | null;
  error: string | null;
  attempts: number;
  ingested_at: string | null;
  chunk_count: number;
}

/** Generation state of a study guide. Same queue as an agent request, and the
 * API only ever creates it as pending — see apps/agent-worker/worker.py. */
export type StudyGuideStatus = "pending" | "processing" | "done" | "failed";

/** One cited line of a guide. The source fields are copied from the chunk at
 * write time, so a citation survives the next re-chunk — same reasoning as
 * the snapshot columns on Suggestion. */
export interface GuidePoint {
  text: string;
  source_chunk_id: string;
  source_filename: string | null;
  source_page_ref: string | null;
  source_excerpt: string | null;
}

export interface GuideTerm {
  term: string;
  definition: string;
  source_chunk_id: string;
  source_filename: string | null;
  source_page_ref: string | null;
  source_excerpt: string | null;
}

export interface Guide {
  title: string;
  sections: { heading: string; points: GuidePoint[] }[];
  key_terms: GuideTerm[];
}

/** What the poll returns: status only, never the guide itself. Fetching the
 * finished guide is a second call to .../study-guide/content. */
export interface StudyGuideStatusRow {
  id: string;
  document_id: string;
  status: StudyGuideStatus;
  attempts: number;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  /** 0-99 while running, from the status poll only; absent until the
   * database has migration 012. An estimate while the model is writing. */
  progress?: number | null;
  /** What the worker is doing: "Finding source material", "Writing"… */
  stage?: string | null;
}

export interface StudyGuideRow extends StudyGuideStatusRow {
  guide: Guide | null;
}

/** Generation state of a quiz. Same queue as a study guide, and the API only
 * ever creates it as pending — see apps/agent-worker/worker.py. */
export type QuizStatus = "pending" | "processing" | "done" | "failed";

/** One question. Options are already shuffled by the worker, and
 * `correct_index` points into them. The source fields are copied from the
 * cited chunk at write time, so a question still says where its answer came
 * from after the next re-chunk — same contract as GuidePoint. */
export interface QuizQuestion {
  question: string;
  options: string[];
  correct_index: number;
  explanation: string;
  source_chunk_id: string;
  source_filename: string | null;
  source_page_ref: string | null;
  source_excerpt: string | null;
}

export interface Quiz {
  title: string;
  questions: QuizQuestion[];
}

export interface QuizStatusRow {
  id: string;
  document_id: string;
  status: QuizStatus;
  attempts: number;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  /** See StudyGuideStatusRow. */
  progress?: number | null;
  stage?: string | null;
}

export interface QuizRow extends QuizStatusRow {
  questions: Quiz | null;
}

/**
 * One comment — a thread root when `parent_id` is null, a reply otherwise.
 *
 * Roots carry the anchor and the resolution; replies carry neither, and the
 * API enforces that with a CHECK constraint (006_comments.sql). The author's
 * name and email are flattened onto the row so the sidebar can render
 * "who said it" without a lookup per comment.
 */
export interface Comment {
  id: string;
  document_id: string;
  parent_id: string | null;
  author_id: string;
  author_name: string;
  author_email: string;
  body: string;
  /** Roots only. Same shape as Suggestion.anchor — see lib/anchors.ts. */
  anchor: Anchor | null;
  /** The passage as it read when the thread was opened, so a comment whose
   * text is later deleted can still say what it was about. */
  quote: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  created_at: string;
  edited_at: string | null;
  mentioned_user_ids: string[];
}

/** A root plus its replies, assembled on the client — the API returns one
 * flat list because the editor needs every row anyway to draw highlights. */
export interface CommentThread {
  root: Comment;
  replies: Comment[];
}

/** One thing said about the text, with where in the text it was said.
 *
 * The annotation margin merges the agent's suggestions and the group's
 * comment threads into a single stream ordered by `from`, because a margin
 * holds everything said about a passage regardless of who said it. Computed
 * in Editor.tsx from the two decoration sets. */
export interface AnchoredAnnotation {
  kind: "suggestion" | "comment";
  id: string;
  /** ProseMirror document position of the start of the anchored span. */
  from: number;
}

/** One cited excerpt on a chat answer. `n` is the [n] marker in the body. */
export interface ChatCitation {
  n: number;
  chunk_id: string;
  filename: string;
  page_ref: string | null;
  excerpt: string;
}

/** One section of a notes plan. `pages` are the worker's page numbers for
 * the material, carried back unchanged when the plan is approved. */
export interface OutlineSection {
  heading: string;
  summary: string;
  pages: number[];
}

/** How "Make notes" delivers: "plan" asks for an outline to approve first,
 * "auto" writes straight into the document. */
export type NotesMode = "plan" | "auto";

/** Questions are always "done"; answers move pending -> processing -> done |
 * failed, and their body grows while "processing". */
export type ChatStatus = "pending" | "processing" | "done" | "failed";

export interface ChatMessage {
  id: string;
  study_space_id: string;
  role: "user" | "assistant";
  /** "notes" answers are notes written from whole files, for inserting into
   * the document; "plan" is the outline for notes not yet written; "answer"
   * is an ordinary reply. Always "answer" on questions. */
  kind: "answer" | "notes" | "plan";
  author_id: string | null;
  author_name: string | null;
  reply_to: string | null;
  body: string;
  citations: ChatCitation[] | null;
  status: ChatStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  /** On notes and plan answers; null means the notes wait for Insert. */
  mode: NotesMode | null;
  /** The document the notes were asked for, and are inserted into. */
  document_id: string | null;
  outline: OutlineSection[] | null;
  /** Notes: when they went into the document. Plan: when it was approved. */
  applied_at: string | null;
  applied_by: string | null;
  /** On an answer, who asked. */
  requested_by: string | null;
}
