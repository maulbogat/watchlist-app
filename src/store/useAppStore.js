import { create } from "zustand";

/**
 * React UI state (Zustand).
 * @typedef {"personal" | { type: "personal", listId: string, name?: string } | { type: "shared", listId: string, name?: string }} ListMode
 */

/** @type {import("zustand").UseBoundStore<import("zustand").StoreApi<AppState>>} */
export const useAppStore = create((set) => ({
  movies: [],
  setMovies: (movies) => set({ movies }),

  currentFilter: "both",
  setCurrentFilter: (currentFilter) => set({ currentFilter }),

  currentGenre: "",
  setCurrentGenre: (currentGenre) => set({ currentGenre }),

  currentStatus: "to-watch",
  setCurrentStatus: (currentStatus) => set({ currentStatus }),

  currentModalMovie: null,
  setCurrentModalMovie: (currentModalMovie) => set({ currentModalMovie }),

  /** @type {ListMode} */
  currentListMode: "personal",
  setCurrentListMode: (currentListMode) => set({ currentListMode }),

  sharedLists: [],
  setSharedLists: (sharedLists) => set({ sharedLists }),

  personalLists: [],
  setPersonalLists: (personalLists) => set({ personalLists }),

  upcomingAlertsExpanded: false,
  setUpcomingAlertsExpanded: (upcomingAlertsExpanded) => set({ upcomingAlertsExpanded }),

  userCountryCode: "IL",
  setUserCountryCode: (userCountryCode) => set({ userCountryCode }),
}));

/**
 * @typedef {Object} AppState
 * @property {unknown[]} movies
 * @property {(movies: unknown[]) => void} setMovies
 * @property {string} currentFilter
 * @property {(v: string) => void} setCurrentFilter
 * @property {string} currentGenre
 * @property {(v: string) => void} setCurrentGenre
 * @property {string} currentStatus
 * @property {(v: string) => void} setCurrentStatus
 * @property {unknown | null} currentModalMovie
 * @property {(v: unknown | null) => void} setCurrentModalMovie
 * @property {ListMode} currentListMode
 * @property {(v: ListMode) => void} setCurrentListMode
 * @property {unknown[]} sharedLists
 * @property {(v: unknown[]) => void} setSharedLists
 * @property {unknown[]} personalLists
 * @property {(v: unknown[]) => void} setPersonalLists
 * @property {boolean} upcomingAlertsExpanded
 * @property {(v: boolean) => void} setUpcomingAlertsExpanded
 * @property {string} userCountryCode
 * @property {(v: string) => void} setUserCountryCode
 */

/** Re-export shared UI constants for components that import from the store module. */
export {
  STATUS_ORDER,
  GENRE_LIMIT,
  STATUS_LABELS,
  CHECK_SVG,
  UPCOMING_CAL_ICON_SVG,
  UPCOMING_ADD_CAL_ICON_SVG,
} from "./watchlistConstants.js";
