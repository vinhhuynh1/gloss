import type { Source } from "./types";

/** The sources a guide or quiz can be built from right now. */
export function readySources(sources: Source[]): Source[] {
  return sources.filter((s) => s.status === "ready");
}

/** What to send as `source_ids`. Sends nothing only when every ready source
 * is checked and no source is still pending or processing, so the default
 * request stays on the API's "all sources" path. While a file is processing,
 * the checked ready ids are sent so the request matches what the picker shows. */
export function selectionToRequest(
  sources: Source[],
  checked: Set<string>
): string[] | undefined {
  const ready = readySources(sources);
  const ids = ready.filter((s) => checked.has(s.id)).map((s) => s.id);
  const waiting = sources.some(
    (s) => s.status === "pending" || s.status === "processing"
  );
  return ids.length === ready.length && !waiting ? undefined : ids;
}
