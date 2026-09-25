/**
 * The whole router.
 *
 * Two screens do not need react-router, but they do need a URL: without one
 * you cannot open the same document in two tabs without clicking through the
 * space list in each, and you cannot send a classmate a link.
 *
 * Hash routing rather than history.pushState, deliberately. With pushState a
 * hard load of /spaces/<uuid> is a request the static host has to be told to
 * rewrite to index.html — a per-host config (Vercel rewrites, Netlify
 * _redirects, an S3 error-document rule) that is easy to get wrong and whose
 * failure mode is a 404 that only appears in production. The hash is never
 * sent to the server, so "/" is the only path that is ever requested and no
 * host needs configuring. The cost is a uglier URL; switching later is
 * contained to this file plus one rewrite rule.
 */
import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

function getSnapshot(): string {
  return window.location.hash.replace(/^#/, "") || "/";
}

/** The current route, e.g. "/" or "/spaces/<uuid>". */
export function useHashRoute(): string {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Navigate. Assigning the hash is what fires `hashchange`. */
export function navigate(path: string): void {
  window.location.hash = path;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** `/spaces/<uuid>` and `/spaces/<uuid>/docs/<uuid>`.
 *
 * The document segment is optional so every link shared before documents had
 * their own URLs still opens — it now means "this space's first document",
 * which is what it always meant. */
const SPACE_ROUTE = new RegExp(`^/spaces/(${UUID})(?:/docs/(${UUID}))?$`, "i");

/** The study-space id in `route`, or null if this is not a space route. */
export function spaceIdFromRoute(route: string): string | null {
  return SPACE_ROUTE.exec(route)?.[1] ?? null;
}

/** The document id in `route`, or null when the route names only a space.
 *
 * Null is not an error: it means "whichever document this space opens with",
 * and SpacePage resolves that once the list has loaded. */
export function documentIdFromRoute(route: string): string | null {
  return SPACE_ROUTE.exec(route)?.[2] ?? null;
}
