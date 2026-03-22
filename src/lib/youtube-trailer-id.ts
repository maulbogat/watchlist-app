/**
 * Stored TMDB YouTube trailer key: a real YouTube video id string, or null when no trailer.
 */

export const YOUTUBE_VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

export function isPlayableYoutubeTrailerId(v: unknown): v is string {
  if (v == null || typeof v !== "string") return false;
  return YOUTUBE_VIDEO_ID_RE.test(v.trim());
}

/**
 * Normalize a value before writing to Firestore (e.g. from TMDB or CLI).
 */
export function normalizeStoredYoutubeTrailerId(v: unknown): string | null {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  if (!YOUTUBE_VIDEO_ID_RE.test(s)) return null;
  return s;
}
