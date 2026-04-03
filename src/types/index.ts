/** Domain + UI types aligned with Firestore + React state. */

export type MediaType = "movie" | "show";

export type StatusKey = "to-watch" | "watched";

export type FilterType = "both" | "movie" | "show";
export type SortType = "title-asc" | "release-desc" | "added-desc";

export type ServicesByRegion = Record<string, string[]>;

/** Hydrated list row (titleRegistry merge + runtime `status`). */
export interface WatchlistItem {
  registryId?: string;
  addedAt?: string | null;
  /** Shared list only: Firebase Auth uid of who added the row (`sharedLists.items[]`). */
  addedByUid?: string | null;
  /** Shared list: denormalized on the list row at write time; merge fills gaps from `users/{uid}`. */
  addedByDisplayName?: string | null;
  /** Shared list: denormalized on the list row at write time; merge fills gaps from `users/{uid}`. */
  addedByPhotoUrl?: string | null;
  title: string;
  year: number | null;
  type: MediaType;
  genre: string;
  thumb: string | null;
  youtubeId: string | null;
  imdbId: string | null;
  tmdbId: number | null;
  services: string[];
  servicesByRegion: ServicesByRegion | null | undefined;
  tmdbMedia?: string | null;
  /** TMDB `original_language` (ISO 639-1), lowercase when from API. */
  originalLanguage?: string | null;
  status?: StatusKey;
  /** Set when the item was opened from the recommendations strip. */
  source?: "recommendation";
}

export interface PersonalList {
  id: string;
  name: string;
  count: number;
  isDefault?: boolean;
  items?: WatchlistItem[];
  watched?: string[];
  maybeLater?: string[];
  archive?: string[];
  createdAt?: string;
}

export interface SharedList {
  id: string;
  name: string;
  ownerId?: string;
  members?: string[];
  items?: WatchlistItem[];
  watched?: string[];
  maybeLater?: string[];
  archive?: string[];
  createdAt?: string;
}

export interface UserProfile {
  country: string | null;
  countryName: string | null;
  /** Shown for “added by” on shared lists; stored on `users/{uid}`. */
  displayName?: string | null;
  /** Synced from Firebase Auth `photoURL`; stored on `users/{uid}`. */
  photoURL?: string | null;
  listName?: string;
  defaultPersonalListId?: string | null;
  /** Digits-only E.164 keys; same ids as `phoneIndex/{phone}` documents. */
  phoneNumbers?: string[];
  upcomingDismissals?: Record<string, string>;
}

/** Firestore `upcomingAlerts` doc merged with `id` after client fetch. */
export interface UpcomingAlert {
  id?: string;
  catalogTmdbId?: number;
  media?: "tv" | "movie";
  sequelTmdbId?: number | null;
  tmdbId?: number;
  type?: "tv" | "movie";
  alertType: "new_episode" | "new_season" | "upcoming_movie" | "sequel";
  title: string;
  detail: string;
  airDate: string | null;
  confirmed: boolean;
  fingerprint: string;
  detectedAt?: string | { toDate?: () => Date };
  expiresAt?: string;
}

export interface RecommendationReference {
  title: string;
  isFavorite: boolean;
}

export interface RecommendationItem {
  tmdbId: number;
  imdbId: string | null;
  title: string;
  year: number | null;
  type: "movie" | "show";
  mediaType: "movie" | "tv";
  genres: string[];
  thumb: string | null;
  youtubeId: string | null;
  refCount: number;
  references: RecommendationReference[];
  explanation: string;
  registryId: string | null;
  services: string[];
}

export interface RecommendationDoc {
  listId: string;
  generatedAt: string;
  source: string;
  algorithmVersion: string;
  items: RecommendationItem[];
}

/** Active list selection (Zustand). `type` is narrowed at runtime in most paths. */
export type ListMode =
  | "personal"
  | { type: "personal"; listId: string; name?: string }
  | { type: "shared"; listId: string; name: string }
  | { type: string; listId: string; name?: string };

export interface AppFilters {
  type: FilterType;
  genre: string;
  status: string;
}

export interface Country {
  code: string;
  name: string;
  flag: string;
  searchKey: string;
}

/** Raw Firestore list row before hydration. */
export type FirestoreListRow = Record<string, unknown> & { registryId?: string };

export interface StatusData {
  items: FirestoreListRow[];
  watched: string[];
  maybeLater: string[];
  archive: string[];
  listName: string;
  defaultPersonalListId: string | null;
  country: string | null;
  countryName: string | null;
  upcomingDismissals: Record<string, string>;
}
