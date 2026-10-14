import { apiFetch } from "./api";

interface Allowance {
  is_guest: boolean;
  limits: Record<string, { used: number; limit: number }>;
}

/** Uploads a demo guest has left, or null for a signed-up user. */
export async function fetchUploadsLeft(): Promise<number | null> {
  const a = await apiFetch<Allowance>("/me/allowance");
  const upload = a.limits.upload;
  if (!a.is_guest || !upload) return null;
  return Math.max(0, upload.limit - upload.used);
}
