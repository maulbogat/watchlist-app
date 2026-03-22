export const STATUS_ORDER = ["to-watch", "watched", "archive"];

export const GENRE_LIMIT = 10;

export const STATUS_LABELS = {
  "to-watch": "To Watch",
  watched: "Watched",
  archive: "Archive",
};

export const CHECK_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';

export const UPCOMING_CAL_ICON_SVG = `<svg class="upcoming-alert-cal-icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zM5 8V6h14v2H5z"/></svg>`;

export const UPCOMING_ADD_CAL_ICON_SVG = `<svg class="upcoming-alert-add-cal-icon" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="currentColor" d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zM5 8V6h14v2H5zm7 5h2v3h3v2h-3v3h-2v-3H9v-2h3z"/></svg>`;

export let movies = [];
export function setMovies(v) {
  movies = v;
}

export let currentFilter = "both"; // 'both' | 'movie' | 'show'
export function setCurrentFilter(v) {
  currentFilter = v;
}

export let currentGenre = ""; // '' = all, or genre name
export function setCurrentGenre(v) {
  currentGenre = v;
}

export let currentStatus = "to-watch"; // 'to-watch' | 'watched'
export function setCurrentStatus(v) {
  currentStatus = v;
}

export let currentModalMovie = null; // movie currently shown in modal
export function setCurrentModalMovie(v) {
  currentModalMovie = v;
}

/** "personal" | { type: "personal", listId, name } | { type: "shared", listId, name } */
export let currentListMode = "personal";
export function setCurrentListMode(v) {
  currentListMode = v;
}

export let sharedLists = [];
export function setSharedLists(v) {
  sharedLists = v;
}

export let personalLists = [];
export function setPersonalLists(v) {
  personalLists = v;
}

/** Inline expansion for upcoming alert pills (>3 items). */
export let upcomingAlertsExpanded = false;
export function setUpcomingAlertsExpanded(v) {
  upcomingAlertsExpanded = v;
}

/** User's selected country code (e.g. 'IL') for TMDB watch provider API. Set from Firestore profile. */
export let userCountryCode = "IL";
export function setUserCountryCode(v) {
  userCountryCode = v;
}
