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

export interface Source {
  id: string;
  study_space_id: string;
  filename: string;
  uploaded_by: string;
  uploaded_at: string;
}

export interface Suggestion {
  id: string;
  document_id: string;
  type: SuggestionType;
  // Serialized Yjs relative position — opaque here, decoded with
  // Y.decodeRelativePosition on the client.
  anchor: Record<string, unknown>;
  proposed_text: string;
  source_chunk_id: string | null;
  status: SuggestionStatus;
  created_at: string;
}
