// Shared between the web app and (conceptually) the API. If you later add
// a TypeScript layer to the backend, this file is the single source of
// truth both sides import from.

export type SuggestionType = "citation" | "contradiction" | "gap_fill";
export type SuggestionStatus = "pending" | "accepted" | "rejected";

export interface StudySpace {
  id: string;
  course_name: string;
  created_by: string;
  created_at: string;
}

export interface DocumentSnapshot {
  id: string;
  study_space_id: string;
  crdt_snapshot: string | null; // base64-encoded Yjs update
  updated_at: string;
}

/** Ingestion state. Only `ready` sources are retrievable by the agent —
 * the transitions belong to apps/agent-worker/worker.py. */
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
  /** Set on `failed` only, and written to be read by the person who
   * uploaded the file rather than by a log reader. */
  error: string | null;
  attempts: number;
  ingested_at: string | null;
  /** Counted per request rather than stored on the row. Zero on a source
   * that has not been processed yet. */
  chunk_count: number;
}

/** Two serialized Yjs relative positions (Y.relativePositionToJSON) and the
 * text they bounded when created. `from`/`to` are absent on suggestions made
 * from the agent CLI. See apps/web/src/lib/anchors.ts. */
export interface Anchor {
  from?: unknown;
  to?: unknown;
  quote?: string;
  source?: string;
}

export interface Suggestion {
  id: string;
  document_id: string;
  type: SuggestionType;
  anchor: Anchor;
  proposed_text: string;
  source_chunk_id: string | null;
  /** Snapshotted from the cited chunk, so the citation survives re-chunking. */
  source_filename: string | null;
  source_page_ref: string | null;
  source_excerpt: string | null;
  status: SuggestionStatus;
  created_at: string;
}

export type AgentRequestStatus = "pending" | "processing" | "done" | "failed";

/** One "check this passage" request, queued by the editor and answered by
 * apps/agent-worker/worker.py. */
export interface AgentRequest {
  id: string;
  document_id: string;
  passage: string;
  status: AgentRequestStatus;
  attempts: number;
  error: string | null;
  /** "none" means the agent checked and found nothing to flag. */
  result_type: SuggestionType | "none" | null;
  suggestion_id: string | null;
  created_at: string;
  finished_at: string | null;
}
