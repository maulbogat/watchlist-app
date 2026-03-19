/**
 * Stored TMDB YouTube trailer key: a real YouTube video id string, or null when no trailer.
 * Playable ids match the usual 11-character YouTube video id format (same as TMDB `key`).
 */

/** YouTube video ids from TMDB are standard 11-char keys. */
export const YOUTUBE_VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

/** @param {unknown} v */
export function isPlayableYoutubeTrailerId(v) {
  if (v == null || typeof v !== "string") return false;
  return YOUTUBE_VIDEO_ID_RE.test(v.trim());
}

/**
 * Normalize a value before writing to Firestore (e.g. from TMDB or CLI).
 * @param {unknown} v
 * @returns {string|null}
 */
export function normalizeStoredYoutubeTrailerId(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  if (!YOUTUBE_VIDEO_ID_RE.test(s)) return null;
  return s;
}
