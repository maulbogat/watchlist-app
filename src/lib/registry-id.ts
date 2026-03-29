/**
 * Stable Firestore document id for titleRegistry — canonical title identity.
 */
export function normalizeImdbId(v: unknown): string | null {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.startsWith("tt") ? s : `tt${s.replace(/^tt/i, "")}`;
}

function legacyKeyFromTitleYear(m: { title?: unknown; year?: unknown }): string {
  const title = String(m?.title ?? "unknown").trim() || "unknown";
  const year = m?.year != null && m.year !== "" ? String(m.year) : "";
  const raw = `${title}|${year}`;
  let h = 0;
  for (let i = 0; i < raw.length; i++) h = (h * 31 + raw.charCodeAt(i)) | 0;
  return `legacy-${Math.abs(h).toString(36)}`;
}

export function registryDocIdFromItem(item: Record<string, unknown> | null | undefined): string {
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

export function payloadForRegistry(
  full: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  if (!full || typeof full !== "object") return {};
  const { status: _s, registryId: _r, ...rest } = full;
  return { ...rest };
}

export function listKey(
  m: { registryId?: string; title?: unknown; year?: unknown } | null | undefined
): string {
  if (m?.registryId) return m.registryId;
  return `${m?.title ?? ""}|${m?.year ?? ""}`;
}
