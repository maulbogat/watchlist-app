import { GENRE_LIMIT } from "../store/watchlistConstants.js";
import type { WatchlistItem } from "../types/index.js";
import { listKey } from "./registry-id.js";

export function isGenrePresentInMovies(movies: WatchlistItem[] | undefined, genre: string): boolean {
  if (!genre) return true;
  const g = genre.toLowerCase();
  return (movies || []).some((m) => {
    const gs = String(m?.genre || "");
    return gs.split(/\s*\/\s*/).some((s) => s.trim().toLowerCase() === g);
  });
}

export interface AddedByFilterOption {
  uid: string;
  label: string;
}

/** Distinct adders on a shared list (for filter chips). */
export function getUniqueAddersFromMovies(
  movies: WatchlistItem[] | undefined,
  viewerUid: string | null | undefined
): AddedByFilterOption[] {
  const seen = new Map<string, string>();
  for (const m of movies || []) {
    const uid = typeof m.addedByUid === "string" && m.addedByUid.trim() ? m.addedByUid.trim() : "";
    if (!uid || seen.has(uid)) continue;
    const dn = m.addedByDisplayName?.trim();
    if (viewerUid && uid === viewerUid) seen.set(uid, "You");
    else if (dn) seen.set(uid, dn);
    else seen.set(uid, "Member");
  }
  return [...seen.entries()]
    .map(([uid, label]) => ({ uid, label }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
}

export function isAddedByPresentInMovies(movies: WatchlistItem[] | undefined, addedByUid: string): boolean {
  if (!addedByUid.trim()) return true;
  return (movies || []).some((m) => m.addedByUid === addedByUid);
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
  currentSearch: string;
  /** Shared lists: restrict to this `addedByUid`; empty = all. */
  currentAddedByUid?: string;
}

/** Pure filter pipeline for the grid (type, status tab, genre, added-by on shared lists, sort). */
export function filterTitles(movies: WatchlistItem[] | undefined, filters: FilterState): WatchlistItem[] {
  const listMovies = movies || [];
  const search = filters.currentSearch.trim().toLowerCase();
  const addedBy = (filters.currentAddedByUid ?? "").trim();

  function matchesSearch(movie: WatchlistItem): boolean {
    if (!search) return true;
    return String(movie.title || "").toLowerCase().includes(search);
  }

  function matchesAddedBy(movie: WatchlistItem): boolean {
    if (!addedBy) return true;
    return movie.addedByUid === addedBy;
  }

  function toEpochOrNegInf(value: unknown): number {
    if (typeof value !== "string" || !value.trim()) return Number.NEGATIVE_INFINITY;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
  }

  const sourceIndexByKey = new Map<string, number>();
  for (let i = 0; i < listMovies.length; i++) {
    const m = listMovies[i];
    if (!m) continue;
    const k = listKey(m);
    if (!sourceIndexByKey.has(k)) sourceIndexByKey.set(k, i);
  }

  function sortByAddedAt(list: WatchlistItem[], ascending: boolean): WatchlistItem[] {
    return [...list].sort((a, b) => {
      const aMs = toEpochOrNegInf(a.addedAt);
      const bMs = toEpochOrNegInf(b.addedAt);
      const ai = sourceIndexByKey.get(listKey(a)) ?? -1;
      const bi = sourceIndexByKey.get(listKey(b)) ?? -1;
      if (aMs !== bMs) return ascending ? aMs - bMs : bMs - aMs;
      return ascending ? ai - bi : bi - ai;
    });
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
    if (filters.currentSort === "added-desc") {
      return sortByAddedAt(list, false);
    }
    if (filters.currentSort === "added-asc") {
      return sortByAddedAt(list, true);
    }
    return [...list].sort((a, b) =>
      String(a.title).localeCompare(String(b.title), undefined, { sensitivity: "base" })
    );
  }

  let list =
    filters.currentFilter === "both" ? listMovies : listMovies.filter((m) => m.type === filters.currentFilter);
  list = list.filter((m) => matchesAddedBy(m));
  list = list.filter((m) => {
    if (filters.currentStatus === "all") return true;
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
  if (search) {
    list = list.filter((m) => matchesSearch(m));
  }

  return sortVisibleTitles(list);
}
