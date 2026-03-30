/**
 * Stable Firestore document id for titleRegistry — canonical title identity.
 * - Prefer IMDb id: tt1234567
 * - Else TMDB + media: tmdb-tv-{id} | tmdb-movie-{id}
 * - Else deterministic legacy key from title|year
 */

export function normalizeImdbId(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.startsWith("tt") ? s : `tt${s.replace(/^tt/i, "")}`;
}

function legacyKeyFromTitleYear(m) {
  const title = String(m?.title ?? "unknown").trim() || "unknown";
  const year = m?.year != null && m.year !== "" ? String(m.year) : "";
  const raw = `${title}|${year}`;
  let h = 0;
  for (let i = 0; i < raw.length; i++) h = (h * 31 + raw.charCodeAt(i)) | 0;
  return `legacy-${Math.abs(h).toString(36)}`;
}

/**
 * @param {object} item — full metadata row (imdbId, tmdbId, type, tmdbMedia, title, year, …)
 * @returns {string} Firestore-safe registry doc id
 */
export function registryDocIdFromItem(item) {
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

/** Strip UI-only / list-only fields before writing titleRegistry */
export function payloadForRegistry(full) {
  if (!full || typeof full !== "object") return {};
  const { status, registryId, ...rest } = full;
  return { ...rest };
}

/**
 * Stable key for watched / maybeLater arrays and list membership.
 * @param {object} m — stored list row `{ registryId }` or legacy embedded row
 */
export function listKey(m) {
  if (m?.registryId) return m.registryId;
  return `${m.title}|${m.year ?? ""}`;
}
