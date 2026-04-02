import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  auth,
  getRecommendations,
  getDismissedRecommendations,
  dismissRecommendation,
  getDefaultPersonalListId,
} from "../firebase.js";
import { addTitleToList } from "../data/titles.js";
import { invalidateUserListQueries } from "./useWatchlist.js";
import type { ListMode, RecommendationDoc, WatchlistItem } from "../types/index.js";

/**
 * Fetch the pre-computed recommendations doc for the active list.
 * Handles "personal" alias → resolves to the real Firestore list ID.
 * staleTime: 1 hour (recommendations only change when the batch script runs).
 */
export function useRecommendations(uid: string | undefined, listMode: ListMode | undefined) {
  const listModeKey =
    listMode === undefined || listMode === null
      ? null
      : typeof listMode === "object"
        ? listMode.listId
        : listMode;

  return useQuery<RecommendationDoc | null>({
    queryKey: ["recommendations", uid, listModeKey],
    queryFn: async () => {
      if (!uid || !listMode) return null;
      let listId: string | null = null;
      if (
        listMode === "personal" ||
        (typeof listMode === "object" && listMode.listId === "personal")
      ) {
        listId = await getDefaultPersonalListId(uid);
      } else if (typeof listMode === "object") {
        listId = listMode.listId;
      }
      if (!listId) return null;
      return getRecommendations(listId);
    },
    enabled: Boolean(uid) && Boolean(listMode),
    staleTime: 60 * 60 * 1000,
  });
}

/**
 * Load the set of tmdbIds the user has previously dismissed.
 * Served from Firestore local cache on subsequent renders.
 */
export function useDismissedRecommendations(uid: string | undefined) {
  return useQuery<Set<number>>({
    queryKey: ["dismissedRecs", uid],
    queryFn: async () => {
      if (!uid) return new Set<number>();
      return getDismissedRecommendations(uid);
    },
    enabled: Boolean(uid),
    staleTime: 60 * 60 * 1000,
  });
}

/**
 * Returns a stable callback that dismisses a recommendation:
 * optimistically updates the TanStack Query cache, then persists to Firestore.
 */
export function useDismissRecommendation(uid: string | undefined) {
  const queryClient = useQueryClient();
  return useCallback(
    (tmdbId: number) => {
      // Optimistic update
      queryClient.setQueryData<Set<number>>(["dismissedRecs", uid], (prev) => {
        const next = new Set(prev ?? []);
        next.add(tmdbId);
        return next;
      });
      if (uid) {
        void dismissRecommendation(uid, tmdbId).catch((err) => {
          console.warn("dismissRecommendation failed:", err);
        });
      }
    },
    [uid, queryClient]
  );
}

/**
 * Mutation for adding a recommendation to the current list.
 *
 * - Path A (item has `registryId`): direct client-side Firestore add via `addTitleToList`.
 * - Path B (no `registryId`): calls `POST /api/add-from-tmdb` which fetches TMDB metadata,
 *   creates a `titleRegistry` doc, and adds the item to the list server-side.
 *
 * On success: auto-dismisses the rec and invalidates watchlist queries.
 */
export function useAddRecommendation(uid: string | undefined) {
  const queryClient = useQueryClient();
  const dismiss = useDismissRecommendation(uid);

  return useMutation({
    mutationFn: async ({
      item,
      listMode,
    }: {
      item: WatchlistItem;
      listMode: ListMode;
    }): Promise<{ registryId: string; title: string }> => {
      if (!uid) throw new Error("Not signed in");

      if (item.registryId) {
        // Path A: title already in registry — direct Firestore
        await addTitleToList(uid, listMode, { ...item, status: "to-watch" });
        return { registryId: item.registryId, title: item.title };
      }

      // Path B: title not in registry — call API to fetch TMDB + create registry doc
      let listId: string;
      let listType: "personal" | "shared";
      if (typeof listMode === "object" && listMode.type === "shared") {
        listId = listMode.listId;
        listType = "shared";
      } else if (typeof listMode === "object" && listMode.type === "personal") {
        listId = listMode.listId;
        listType = "personal";
      } else {
        const defaultId = await getDefaultPersonalListId(uid);
        if (!defaultId)
          throw new Error("No personal list found. Open the app and set up a list first.");
        listId = defaultId;
        listType = "personal";
      }

      const token = await auth.currentUser?.getIdToken();
      if (!token) throw new Error("Not authenticated");

      const mediaType = item.tmdbMedia === "tv" || item.type === "show" ? "tv" : "movie";

      const res = await fetch("/api/add-from-tmdb", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ tmdbId: item.tmdbId, mediaType, listId, listType }),
      });

      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `Failed to add title (${res.status})`);
      }

      return (await res.json()) as { registryId: string; title: string };
    },
    onSuccess: (_, { item }) => {
      if (item.tmdbId != null) dismiss(item.tmdbId);
      if (uid) void invalidateUserListQueries(queryClient, uid);
    },
  });
}
