import type { User } from "firebase/auth";
import type { ListMode } from "../types/index.js";

const FILTER_STORAGE_PREFIX = "watchlist_filters_";

export function saveLastList(user: User | null, mode: ListMode): void {
  const val =
    mode === "personal" ? "personal" : typeof mode === "object" && mode?.listId ? mode.listId : "personal";
  try {
    if (user) localStorage.setItem(`watchlist_lastList_${user.uid}`, val);
  } catch {
    /* quota / private mode */
  }
}

export function getLastListFromStorage(uid: string): string | null {
  try {
    return localStorage.getItem(`watchlist_lastList_${uid}`) || null;
  } catch {
    return null;
  }
}

export function getLastList(user: User | null): string | null {
  if (!user) return null;
  return getLastListFromStorage(user.uid);
}

export function getFilterStorageKey(uid: string): string {
  return `${FILTER_STORAGE_PREFIX}${uid}`;
}

export interface FilterPrefsSnapshot {
  currentFilter: string;
  currentGenre: string;
  currentStatus: string;
}

/** Read saved type / status / genre filters from localStorage (per signed-in user). */
export function readFilterPreferences(user: User | null): FilterPrefsSnapshot | null {
  if (!user) return null;
  try {
    const raw = localStorage.getItem(getFilterStorageKey(user.uid));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const o = parsed as Record<string, unknown>;
    return {
      currentFilter: typeof o.currentFilter === "string" ? o.currentFilter : "both",
      currentGenre: typeof o.currentGenre === "string" ? o.currentGenre : "",
      currentStatus: typeof o.currentStatus === "string" ? o.currentStatus : "to-watch",
    };
  } catch {
    return null;
  }
}

/** Persist filters from an explicit snapshot (React). */
export function persistFilterPreferences(user: User | null, prefs: FilterPrefsSnapshot): void {
  if (!user) return;
  try {
    localStorage.setItem(
      getFilterStorageKey(user.uid),
      JSON.stringify({
        currentFilter: prefs.currentFilter,
        currentGenre: prefs.currentGenre,
        currentStatus: prefs.currentStatus,
      })
    );
  } catch {
    /* quota */
  }
}
