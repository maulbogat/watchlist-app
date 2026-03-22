import {
  currentFilter,
  currentGenre,
  currentStatus,
  setCurrentFilter,
  setCurrentStatus,
  setCurrentGenre,
} from "../store/state.js";

const FILTER_STORAGE_PREFIX = "watchlist_filters_";

export function getListFromUrl() {
  const list = new URLSearchParams(window.location.search).get("list");
  return list || null;
}

export function saveLastList(user, mode) {
  const val =
    mode === "personal" ? "personal" : typeof mode === "object" && mode?.listId ? mode.listId : "personal";
  try {
    if (user) localStorage.setItem(`watchlist_lastList_${user.uid}`, val);
  } catch (e) {}
  const url = new URL(window.location.href);
  url.searchParams.delete("join");
  if (val === "personal") {
    url.searchParams.delete("list");
  } else {
    url.searchParams.set("list", val);
  }
  window.history.replaceState({}, "", url.pathname + (url.search || ""));
}

export function getLastList(user) {
  const fromUrl = getListFromUrl();
  if (fromUrl) return fromUrl;
  if (!user) return null;
  try {
    return localStorage.getItem(`watchlist_lastList_${user.uid}`) || null;
  } catch (e) {
    return null;
  }
}

export function getFilterStorageKey(uid) {
  return `${FILTER_STORAGE_PREFIX}${uid}`;
}

/** Restore type / status / genre filters from localStorage (per signed-in user). */
export function loadFilterPreferences(user) {
  if (!user) return;
  try {
    const raw = localStorage.getItem(getFilterStorageKey(user.uid));
    if (!raw) return;
    const p = JSON.parse(raw);
    if (p.currentFilter === "both" || p.currentFilter === "movie" || p.currentFilter === "show") {
      setCurrentFilter(p.currentFilter);
    }
    if (
      p.currentStatus === "to-watch" ||
      p.currentStatus === "watched" ||
      p.currentStatus === "archive" ||
      p.currentStatus === "recently-added"
    ) {
      setCurrentStatus(p.currentStatus);
    }
    if (typeof p.currentGenre === "string") {
      setCurrentGenre(p.currentGenre);
    }
  } catch (e) {}
}

export function saveFilterPreferences(user) {
  if (!user) return;
  try {
    localStorage.setItem(
      getFilterStorageKey(user.uid),
      JSON.stringify({ currentFilter, currentGenre, currentStatus })
    );
  } catch (e) {}
}
