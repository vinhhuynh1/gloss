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
  updated_at: string;
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
}

export interface StudyGuideRow extends StudyGuideStatusRow {
  guide: Guide | null;
}

/** Generation state of a deck. Same queue as a study guide, and the API only
 * ever creates it as pending — see apps/agent-worker/worker.py. */
export type FlashcardsStatus = "pending" | "processing" | "done" | "failed";

/** One card. The source fields are copied from the cited chunk at write time,
 * so a card still says where its answer came from after the next re-chunk —
 * same contract as GuidePoint. */
export interface Flashcard {
  front: string;
  back: string;
  source_chunk_id: string;
  source_filename: string | null;
  source_page_ref: string | null;
  source_excerpt: string | null;
}

export interface Deck {
  title: string;
  cards: Flashcard[];
}

export interface FlashcardsStatusRow {
  id: string;
  document_id: string;
  status: FlashcardsStatus;
  attempts: number;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface FlashcardsRow extends FlashcardsStatusRow {
  cards: Deck | null;
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
