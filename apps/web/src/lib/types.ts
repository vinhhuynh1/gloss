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

export interface Suggestion {
  id: string;
  document_id: string;
  type: "citation" | "contradiction" | "gap_fill";
  proposed_text: string;
  source_chunk_id: string | null;
  status: "pending" | "accepted" | "rejected";
}
