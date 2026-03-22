import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getPersonalListMovies,
  getPersonalLists,
  getSharedListMovies,
  getSharedListsForUser,
} from "../../firebase.js";

/**
 * @typedef {"personal" | { type: "personal", listId: string, name?: string } | { type: "shared", listId: string, name?: string }} ListMode
 */

/**
 * Serializable slice of list mode for React Query keys.
 * @param {ListMode | undefined} listMode
 */
export function listModeQueryKey(listMode) {
  if (listMode === "personal") return ["personal"];
  if (listMode && typeof listMode === "object" && listMode.type === "personal") {
    return ["personal", listMode.listId];
  }
  if (listMode && typeof listMode === "object" && listMode.type === "shared") {
    return ["shared", listMode.listId];
  }
  return ["none"];
}

/**
 * @param {string | undefined} uid
 * @param {ListMode | undefined} listMode
 */
export async function fetchWatchlistMovies(uid, listMode) {
  if (!uid) return [];
  if (listMode === "personal" || (listMode && listMode.type === "personal")) {
    const listId = listMode === "personal" ? "personal" : listMode.listId;
    try {
      return await getPersonalListMovies(uid, listId);
    } catch (e) {
      console.error("fetchWatchlistMovies (personal):", e);
      return [];
    }
  }
  if (listMode && listMode.type === "shared") {
    try {
      return await getSharedListMovies(listMode.listId);
    } catch (e) {
      console.error("fetchWatchlistMovies (shared):", e);
      return [];
    }
  }
  return [];
}

/**
 * Hydrated movies for the active list (same data as legacy `loadList`).
 * @param {string | undefined} uid
 * @param {ListMode | undefined} listMode
 * @param {import("@tanstack/react-query").UseQueryOptions<any[], Error> & { enabled?: boolean }} [options]
 */
export function useWatchlistMovies(uid, listMode, options = {}) {
  const { enabled: enabledOpt, ...rest } = options;
  const modeKey = listModeQueryKey(listMode);
  const enabled = Boolean(uid) && modeKey[0] !== "none" && enabledOpt !== false;

  return useQuery({
    queryKey: ["watchlistMovies", uid, ...modeKey],
    queryFn: () => fetchWatchlistMovies(uid, listMode),
    enabled,
    ...rest,
  });
}

/**
 * @param {string | undefined} uid
 * @param {import("@tanstack/react-query").UseQueryOptions<any[], Error> & { enabled?: boolean }} [options]
 */
export function usePersonalLists(uid, options = {}) {
  const { enabled: enabledOpt, ...rest } = options;
  return useQuery({
    queryKey: ["personalLists", uid],
    queryFn: () => (uid ? getPersonalLists(uid) : Promise.resolve([])),
    enabled: Boolean(uid) && enabledOpt !== false,
    ...rest,
  });
}

/**
 * @param {string | undefined} uid
 * @param {import("@tanstack/react-query").UseQueryOptions<any[], Error> & { enabled?: boolean }} [options]
 */
export function useSharedLists(uid, options = {}) {
  const { enabled: enabledOpt, ...rest } = options;
  return useQuery({
    queryKey: ["sharedLists", uid],
    queryFn: () => (uid ? getSharedListsForUser(uid) : Promise.resolve([])),
    enabled: Boolean(uid) && enabledOpt !== false,
    ...rest,
  });
}

/**
 * After Firestore mutations, invalidate watchlist + list chrome.
 * @param {import("@tanstack/react-query").QueryClient} queryClient
 * @param {string | undefined} uid
 */
export function invalidateUserListQueries(queryClient, uid) {
  if (!uid) return;
  return queryClient.invalidateQueries({
    predicate: (q) => {
      const key = q.queryKey;
      if (!Array.isArray(key) || key.length < 2) return false;
      if (key[1] !== uid) return false;
      const tag = key[0];
      return (
        tag === "watchlistMovies" ||
        tag === "personalLists" ||
        tag === "sharedLists" ||
        tag === "upcomingBar"
      );
    },
  });
}

/**
 * @returns {(uid: string | undefined) => ReturnType<import("@tanstack/react-query").QueryClient["invalidateQueries"]>}
 */
export function useInvalidateUserListQueries() {
  const queryClient = useQueryClient();
  return (uid) => invalidateUserListQueries(queryClient, uid);
}
