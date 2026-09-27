/**
 * Uploading a source from outside SourcesPanel.
 *
 * The chat bar accepts dropped files too, and those land in the same place —
 * the space's sources — through the same endpoint. SourcesPanel only polls
 * while something of its own is in flight, so an upload it did not start
 * would sit unseen until the page reloaded; the event below tells it to look.
 */
import { apiFetch } from "./api";
import type { Source } from "./types";

export const SOURCES_CHANGED_EVENT = "gloss:sources-changed";

/** "Make notes in chat" on a source that is already uploaded: puts it in the
 * chat bar as if it had just been dropped there, where Make notes and the
 * Plan/Auto choice live. An event rather than a prop because SourcesPanel and
 * the chat sit in different branches of the page. */
export const ATTACH_SOURCE_EVENT = "gloss:attach-source";

export interface AttachSourceDetail {
  id: string;
  filename: string;
}

export function attachSourceToChat(detail: AttachSourceDetail) {
  window.dispatchEvent(new CustomEvent<AttachSourceDetail>(ATTACH_SOURCE_EVENT, { detail }));
}

/** Matches ACCEPT in SourcesPanel and ALLOWED_EXTENSIONS in the API. */
export const SOURCE_ACCEPT = ".pdf,.pptx,.md,.markdown,.txt";

export async function uploadSource(spaceId: string, file: File): Promise<Source> {
  const body = new FormData();
  body.append("file", file);
  const created = await apiFetch<Source>(`/study-spaces/${spaceId}/sources`, {
    method: "POST",
    body,
  });
  window.dispatchEvent(new CustomEvent(SOURCES_CHANGED_EVENT));
  return created;
}
