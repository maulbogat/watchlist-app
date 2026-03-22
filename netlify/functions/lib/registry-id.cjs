/**
 * CommonJS copy of `src/lib/registry-id.ts` for Netlify functions.
 *
 * Derives stable **`titleRegistry` document ids** and list status keys from IMDb / TMDB / legacy title+year.
 * Pure string logic — **no Firestore I/O**.
 *
 * @module netlify/functions/lib/registry-id
 */

/**
 * @typedef {import('../../../src/types/index.js').WatchlistItem} WatchlistItem
 */

/**
 * @param {unknown} v
 * @returns {string | null}
 */
function normalizeImdbId(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.startsWith("tt") ? s : `tt${s.replace(/^tt/i, "")}`;
}

/**
 * @param {Record<string, unknown>} m
 * @returns {string}
 */
function legacyKeyFromTitleYear(m) {
  const title = String(m?.title ?? "unknown").trim() || "unknown";
  const year = m?.year != null && m.year !== "" ? String(m.year) : "";
  const raw = `${title}|${year}`;
  let h = 0;
  for (let i = 0; i < raw.length; i++) h = (h * 31 + raw.charCodeAt(i)) | 0;
  return `legacy-${Math.abs(h).toString(36)}`;
}

/**
 * @param {WatchlistItem | Record<string, unknown> | null | undefined} item
 * @returns {string}
 */
function registryDocIdFromItem(item) {
  if (!item || typeof item !== "object") return legacyKeyFromTitleYear({});
  if (item.registryId && typeof item.registryId === "string") return item.registryId;

  const imdb = normalizeImdbId(item.imdbId);
  if (imdb) return imdb;

  const t = item.tmdbId != null && item.tmdbId !== "" ? Number(item.tmdbId) : NaN;
  if (!Number.isNaN(t)) {
    const isTv = item.tmdbMedia === "tv" || item.type === "show";
    return isTv ? `tmdb-tv-${t}` : `tmdb-movie-${t}`;
  }

  return legacyKeyFromTitleYear(item);
}

/**
 * Strip client-only fields before merging into `titleRegistry`.
 * @param {Record<string, unknown>} full
 * @returns {Record<string, unknown>}
 */
function payloadForRegistry(full) {
  if (!full || typeof full !== "object") return {};
  const { status, registryId, ...rest } = full;
  return { ...rest };
}

/**
 * Status-array key for a list row (`registryId` or legacy `title|year`).
 * @param {WatchlistItem | Record<string, unknown> | null | undefined} m
 * @returns {string}
 */
function listKey(m) {
  if (m?.registryId) return m.registryId;
  return `${m.title}|${m.year ?? ""}`;
}

module.exports = {
  normalizeImdbId,
  registryDocIdFromItem,
  payloadForRegistry,
  listKey,
};
