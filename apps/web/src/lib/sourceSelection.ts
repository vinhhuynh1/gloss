import type { Source } from "./types";

/** The sources a guide or quiz can be built from right now. */
export function readySources(sources: Source[]): Source[] {
  return sources.filter((s) => s.status === "ready");
}

/** What to send as `source_ids`. Every ready source checked sends nothing,
 * so the default request stays on the API's "all sources" path and a file
 * that finishes processing later is included too. */
export function selectionToRequest(
  ready: Source[],
  checked: Set<string>
): string[] | undefined {
  const ids = ready.filter((s) => checked.has(s.id)).map((s) => s.id);
  return ids.length === ready.length ? undefined : ids;
}
