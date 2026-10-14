import { describe, expect, it } from "vitest";

import { readySources, selectionToRequest } from "./sourceSelection";
import type { Source } from "./types";

function source(id: string, status: Source["status"] = "ready"): Source {
  return {
    id, study_space_id: "s", filename: `${id}.pdf`, uploaded_by: "u",
    uploaded_at: "2026-10-13T00:00:00Z", status, content_type: null,
    byte_size: null, error: null, attempts: 0, ingested_at: null, chunk_count: 1,
  };
}

describe("selectionToRequest", () => {
  const ready = [source("a"), source("b")];

  it("sends nothing when every ready source is checked", () => {
    expect(selectionToRequest(ready, new Set(["a", "b"]))).toBeUndefined();
  });

  it("sends the checked ids in list order otherwise", () => {
    expect(selectionToRequest(ready, new Set(["b"]))).toEqual(["b"]);
  });

  it("sends an empty list when nothing is checked", () => {
    expect(selectionToRequest(ready, new Set())).toEqual([]);
  });

  it("ignores checked ids that are no longer ready", () => {
    expect(selectionToRequest(ready, new Set(["a", "gone"]))).toEqual(["a"]);
  });
});

describe("readySources", () => {
  it("keeps only ready sources", () => {
    const all = [source("a"), source("b", "processing"), source("c", "failed")];
    expect(readySources(all).map((s) => s.id)).toEqual(["a"]);
  });
});
