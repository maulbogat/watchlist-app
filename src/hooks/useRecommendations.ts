import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getRecommendations,
  getDismissedRecommendations,
  dismissRecommendation,
  getDefaultPersonalListId,
} from "../firebase.js";
import type { ListMode, RecommendationDoc } from "../types/index.js";

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
