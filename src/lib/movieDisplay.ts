import { isPlayableYoutubeTrailerId } from "./youtube-trailer-id.js";
import type { WatchlistItem } from "../types/index.js";

/** Watch-provider names for TMDB region: prefers servicesByRegion[country], then legacy services. */
export function servicesForMovie(
  m: WatchlistItem | Record<string, unknown>,
  countryCode: string | undefined
): string[] {
  const code = (countryCode || "IL").toString().toUpperCase().slice(0, 2);
  const map = (m as WatchlistItem).servicesByRegion;
  if (map && typeof map === "object" && Array.isArray((map as Record<string, unknown>)[code])) {
    return (map as Record<string, string[]>)[code] ?? [];
  }
  const services = (m as WatchlistItem).services;
  return Array.isArray(services) ? services : [];
}

/** Stored TMDB YouTube trailer key — playable only if valid 11-char YouTube id */
export function hasPlayableTrailerYoutubeId(
  m: { youtubeId?: string | null } | null | undefined
): boolean {
  return isPlayableYoutubeTrailerId(m?.youtubeId);
}

export function renderServiceChips(
  services: string[] | unknown,
  opts: { limit?: number } = {}
): string {
  const list = Array.isArray(services) ? services : [];
  const sliced = typeof opts.limit === "number" ? list.slice(0, opts.limit) : list;
  if (!sliced.length) return "";

  return `<span class="service-chips">${sliced
    .map((s) => {
      const key = String(s).trim().toLowerCase();
      const label = String(s).trim();
      return `<span class="service-chip" data-service="${key}">${label}</span>`;
    })
    .join("")}</span>`;
}
