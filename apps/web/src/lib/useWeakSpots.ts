/**
 * The signed-in person's weak spots for one document.
 *
 * Fetched when the document opens and after each saved attempt, the only
 * moment the numbers can change, so there is no poll. A failed fetch keeps
 * the last list and says nothing: weak spots are a hint layered on the notes,
 * and an error banner for a hint would be louder than the hint itself.
 */
import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "./api";
import type { WeakSpot } from "./types";

export function useWeakSpots(documentId: string) {
  const [spots, setSpots] = useState<WeakSpot[]>([]);

  const refresh = useCallback(async () => {
    try {
      setSpots(await apiFetch<WeakSpot[]>(`/documents/${documentId}/weak-spots`));
    } catch {
      // See the header: keep the last list.
    }
  }, [documentId]);

  useEffect(() => {
    setSpots([]);
    void refresh();
  }, [refresh]);

  return { spots, refresh };
}
