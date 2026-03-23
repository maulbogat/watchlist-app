import { GENRE_LIMIT } from "../store/watchlistConstants.js";
import type { WatchlistItem } from "../types/index.js";

export function isGenrePresentInMovies(movies: WatchlistItem[] | undefined, genre: string): boolean {
  if (!genre) return true;
  const g = genre.toLowerCase();
  return (movies || []).some((m) => {
    const gs = String(m?.genre || "");
    return gs.split(/\s*\/\s*/).some((s) => s.trim().toLowerCase() === g);
  });
}

export function getUniqueGenresFromMovies(movies: WatchlistItem[] | undefined): string[] {
  const count = new Map<string, number>();
  (movies || []).forEach((m) => {
    const g = String(m?.genre || "").trim();
    if (!g) return;
    g.split(/\s*\/\s*/).forEach((s) => {
      const t = s.trim();
      if (t) count.set(t, (count.get(t) || 0) + 1);
    });
  });
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], undefined, { sensitivity: "base" }))
    .slice(0, GENRE_LIMIT)
    .map(([name]) => name);
}

export interface FilterState {
  currentFilter: string;
  currentGenre: string;
  currentStatus: string;
  currentSort: string;
}

/** Pure filter pipeline for the grid (type, status, genre, recently-added). */
export function filterTitles(movies: WatchlistItem[] | undefined, filters: FilterState): WatchlistItem[] {
  const listMovies = movies || [];
  function toEpochOrNegInf(value: unknown): number {
    if (typeof value !== "string" || !value.trim()) return Number.NEGATIVE_INFINITY;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
  }

  function sortVisibleTitles(list: WatchlistItem[]): WatchlistItem[] {
    if (filters.currentSort === "release-desc") {
      return [...list].sort((a, b) => {
        const aYear = typeof a.year === "number" ? a.year : -Infinity;
        const bYear = typeof b.year === "number" ? b.year : -Infinity;
        if (bYear !== aYear) return bYear - aYear;
        return String(a.title).localeCompare(String(b.title), undefined, { sensitivity: "base" });
      });
    }
    return [...list].sort((a, b) =>
      String(a.title).localeCompare(String(b.title), undefined, { sensitivity: "base" })
    );
  }

  if (filters.currentStatus === "recently-added") {
    const recentCandidates: Array<{ movie: WatchlistItem; index: number; addedAtMs: number }> = [];
    for (let i = listMovies.length - 1; i >= 0; i--) {
      const m = listMovies[i];
      if (!m) continue;
      const s = m.status || "to-watch";
      if (s !== "to-watch") continue;
      if (filters.currentFilter !== "both" && m.type !== filters.currentFilter) continue;
      if (filters.currentGenre) {
        const g = String(m.genre || "");
        if (
          !g.split(/\s*\/\s*/).some((s) => s.trim().toLowerCase() === filters.currentGenre.toLowerCase())
        ) {
          continue;
        }
      }
      recentCandidates.push({ movie: m, index: i, addedAtMs: toEpochOrNegInf(m.addedAt) });
    }
    recentCandidates.sort((a, b) => {
      if (b.addedAtMs !== a.addedAtMs) return b.addedAtMs - a.addedAtMs;
      return b.index - a.index;
    });
    return recentCandidates.slice(0, 10).map((entry) => entry.movie);
  }

  let list =
    filters.currentFilter === "both" ? listMovies : listMovies.filter((m) => m.type === filters.currentFilter);
  list = list.filter((m) => {
    const s = m.status || "to-watch";
    if (filters.currentStatus === "to-watch") return s === "to-watch" || s === "maybe-later";
    if (filters.currentStatus === "archive") return s === "archive";
    return s === filters.currentStatus;
  });
  if (filters.currentGenre) {
    list = list.filter((m) => {
      const g = String(m.genre || "");
      return g.split(/\s*\/\s*/).some((s) => s.trim().toLowerCase() === filters.currentGenre.toLowerCase());
    });
  }

  return sortVisibleTitles(list);
}
