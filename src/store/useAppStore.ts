import { create } from "zustand";
import type { User } from "firebase/auth";
import type { FilterType, ListMode, SortType, WatchlistItem } from "../types/index.js";
import {
  STATUS_ORDER,
  GENRE_LIMIT,
  STATUS_LABELS,
  CHECK_SVG,
  UPCOMING_CAL_ICON_SVG,
  UPCOMING_ADD_CAL_ICON_SVG,
} from "./watchlistConstants.js";
import type { SharedList } from "../types/index.js";
import type { PersonalList } from "../types/index.js";

export interface AppState {
  currentUser: User | null;
  setCurrentUser: (user: User | null) => void;

  movies: WatchlistItem[];
  setMovies: (movies: WatchlistItem[]) => void;

  currentFilter: FilterType;
  setCurrentFilter: (currentFilter: FilterType) => void;

  currentSort: SortType;
  setCurrentSort: (currentSort: SortType) => void;

  currentSearch: string;
  setCurrentSearch: (currentSearch: string) => void;

  currentGenre: string;
  setCurrentGenre: (currentGenre: string) => void;

  /** Shared lists only: filter by `addedByUid`; empty string = all members. */
  currentAddedByUid: string;
  setCurrentAddedByUid: (uid: string) => void;

  currentStatus: string;
  setCurrentStatus: (currentStatus: string) => void;

  currentModalMovie: WatchlistItem | null;
  setCurrentModalMovie: (currentModalMovie: WatchlistItem | null) => void;

  currentListMode: ListMode;
  setCurrentListMode: (currentListMode: ListMode) => void;

  sharedLists: SharedList[];
  setSharedLists: (sharedLists: SharedList[]) => void;

  personalLists: PersonalList[];
  setPersonalLists: (personalLists: PersonalList[]) => void;

  userCountryCode: string;
  setUserCountryCode: (userCountryCode: string) => void;

  whatsAppSettingsOpen: boolean;
  setWhatsAppSettingsOpen: (open: boolean) => void;

  bookmarkletSettingsOpen: boolean;
  setBookmarkletSettingsOpen: (open: boolean) => void;

  /** Set when sign-in fails app allowlist (full-screen gate in App). */
  accessDenied: null | "not_invited" | "no_email";
  setAccessDenied: (reason: null | "not_invited" | "no_email") => void;
}

export const useAppStore = create<AppState>()((set) => ({
  currentUser: null,
  setCurrentUser: (currentUser) => set({ currentUser }),

  movies: [],
  setMovies: (movies) => set({ movies }),

  currentFilter: "both",
  setCurrentFilter: (currentFilter) => set({ currentFilter }),

  currentSort: "title-asc",
  setCurrentSort: (currentSort) => set({ currentSort }),

  currentSearch: "",
  setCurrentSearch: (currentSearch) => set({ currentSearch }),

  currentGenre: "",
  setCurrentGenre: (currentGenre) => set({ currentGenre }),

  currentAddedByUid: "",
  setCurrentAddedByUid: (currentAddedByUid) => set({ currentAddedByUid }),

  currentStatus: "to-watch",
  setCurrentStatus: (currentStatus) => set({ currentStatus }),

  currentModalMovie: null,
  setCurrentModalMovie: (currentModalMovie) => set({ currentModalMovie }),

  currentListMode: "personal",
  setCurrentListMode: (currentListMode) => set({ currentListMode }),

  sharedLists: [],
  setSharedLists: (sharedLists) => set({ sharedLists }),

  personalLists: [],
  setPersonalLists: (personalLists) => set({ personalLists }),

  userCountryCode: "IL",
  setUserCountryCode: (userCountryCode) => set({ userCountryCode }),

  whatsAppSettingsOpen: false,
  setWhatsAppSettingsOpen: (whatsAppSettingsOpen) => set({ whatsAppSettingsOpen }),

  bookmarkletSettingsOpen: false,
  setBookmarkletSettingsOpen: (bookmarkletSettingsOpen) => set({ bookmarkletSettingsOpen }),

  accessDenied: null,
  setAccessDenied: (accessDenied) => set({ accessDenied }),
}));

export {
  STATUS_ORDER,
  GENRE_LIMIT,
  STATUS_LABELS,
  CHECK_SVG,
  UPCOMING_CAL_ICON_SVG,
  UPCOMING_ADD_CAL_ICON_SVG,
};
