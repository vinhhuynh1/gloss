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
