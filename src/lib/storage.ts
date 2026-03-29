import type { User } from "firebase/auth";
import type { ListMode } from "../types/index.js";
import type { UpcomingAlert } from "../types/index.js";

const FILTER_STORAGE_PREFIX = "watchlist_filters_";
const UPCOMING_CACHE_PREFIX = "watchlist_upcoming_";
const UPCOMING_CACHE_TTL_MS = 2 * 60 * 60 * 1000;

export function saveLastList(user: User | null, mode: ListMode): void {
  const val =
    mode === "personal"
      ? "personal"
      : typeof mode === "object" && mode?.listId
        ? mode.listId
        : "personal";
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
  currentSort: string;
  currentSearch: string;
  /** Shared list filter; omitted in older stored prefs. */
  currentAddedByUid?: string;
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
      currentSort: typeof o.currentSort === "string" ? o.currentSort : "title-asc",
      currentSearch: typeof o.currentSearch === "string" ? o.currentSearch : "",
      currentAddedByUid: typeof o.currentAddedByUid === "string" ? o.currentAddedByUid : "",
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
        currentSort: prefs.currentSort,
        currentSearch: prefs.currentSearch,
        currentAddedByUid: prefs.currentAddedByUid ?? "",
      })
    );
  } catch {
    /* quota */
  }
}

function upcomingCacheKey(uid: string, ids: string): string {
  return `${UPCOMING_CACHE_PREFIX}${uid}_${encodeURIComponent(ids)}`;
}

type UpcomingCachePayload = {
  expiresAt: number;
  alerts: UpcomingAlert[];
};

export function readUpcomingAlertsCache(uid: string, ids: string): UpcomingAlert[] | null {
  if (!uid || !ids) return null;
  try {
    const raw = localStorage.getItem(upcomingCacheKey(uid, ids));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as UpcomingCachePayload;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.expiresAt !== "number" || parsed.expiresAt <= Date.now()) {
      localStorage.removeItem(upcomingCacheKey(uid, ids));
      return null;
    }
    return Array.isArray(parsed.alerts) ? parsed.alerts : null;
  } catch {
    return null;
  }
}

export function writeUpcomingAlertsCache(uid: string, ids: string, alerts: UpcomingAlert[]): void {
  if (!uid || !ids) return;
  try {
    const payload: UpcomingCachePayload = {
      expiresAt: Date.now() + UPCOMING_CACHE_TTL_MS,
      alerts,
    };
    localStorage.setItem(upcomingCacheKey(uid, ids), JSON.stringify(payload));
  } catch {
    /* quota */
  }
}

export function clearUpcomingAlertsCache(uid?: string): void {
  try {
    const prefix = uid ? `${UPCOMING_CACHE_PREFIX}${uid}_` : UPCOMING_CACHE_PREFIX;
    const toDelete: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (k.startsWith(prefix)) toDelete.push(k);
    }
    toDelete.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* private mode / unavailable storage */
  }
}
