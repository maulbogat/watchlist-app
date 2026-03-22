import { isPlayableYoutubeTrailerId } from "../../lib/youtube-trailer-id.js";

/** Watch-provider names for TMDB region: prefers servicesByRegion[country], then legacy services. */
export function servicesForMovie(m, countryCode) {
  const code = (countryCode || "IL").toString().toUpperCase().slice(0, 2);
  const map = m.servicesByRegion;
  if (map && typeof map === "object" && Array.isArray(map[code])) {
    return map[code];
  }
  return Array.isArray(m.services) ? m.services : [];
}

/** Stored TMDB YouTube trailer key — playable only if valid 11-char YouTube id */
export function hasPlayableTrailerYoutubeId(m) {
  return isPlayableYoutubeTrailerId(m?.youtubeId);
}

export function renderServiceChips(services, { limit } = {}) {
  const list = Array.isArray(services) ? services : [];
  const sliced = typeof limit === "number" ? list.slice(0, limit) : list;
  if (!sliced.length) return "";

  return `<span class="service-chips">${sliced
    .map((s) => {
      const key = String(s).trim().toLowerCase();
      const label = String(s).trim();
      return `<span class="service-chip" data-service="${key}">${label}</span>`;
    })
    .join("")}</span>`;
}
