import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryOptions, QueryClient } from "@tanstack/react-query";
import type { User } from "firebase/auth";
import {
  getPersonalLists,
  getSharedListsForUser,
  getFavorites,
  subscribeFavorites,
} from "../firebase.js";
import { loadList } from "../data/lists.js";
import type { ListMode, PersonalList, SharedList, WatchlistItem } from "../types/index.js";

export function listModeQueryKey(listMode: ListMode | undefined): string[] {
  if (listMode === "personal") return ["personal"];
  if (listMode && typeof listMode === "object" && listMode.type === "personal") {
    /** Virtual default list id — must match bare `"personal"` mode (see `useWatchlistMovies`). */
    if (listMode.listId === "personal") return ["personal"];
    return ["personal", listMode.listId];
  }
  if (listMode && typeof listMode === "object" && listMode.type === "shared") {
    return ["shared", listMode.listId];
  }
  return ["none"];
}

export async function fetchWatchlistMovies(
  uid: string | undefined,
  listMode: ListMode | undefined
): Promise<WatchlistItem[]> {
  if (!uid || listMode === undefined) return [];
  return loadList({ uid } as User, listMode);
}

type ListQueryOpts = Omit<
  UseQueryOptions<WatchlistItem[], Error>,
  "queryKey" | "queryFn" | "enabled"
> & {
  enabled?: boolean;
};

export function useWatchlistMovies(
  uid: string | undefined,
  listMode: ListMode | undefined,
  options: ListQueryOpts = {}
): ReturnType<typeof useQuery<WatchlistItem[], Error>> {
  const { enabled: enabledOpt, ...rest } = options;
  const modeKey = listModeQueryKey(listMode);
  const enabled = Boolean(uid) && modeKey[0] !== "none" && enabledOpt !== false;

  return useQuery({
    queryKey: ["watchlistMovies", uid, ...modeKey],
    queryFn: () => fetchWatchlistMovies(uid, listMode),
    enabled,
    staleTime: 10 * 60 * 1000,
    ...rest,
  });
}

type PersonalOpts = Omit<
  UseQueryOptions<PersonalList[], Error>,
  "queryKey" | "queryFn" | "enabled"
> & {
  enabled?: boolean;
};

export function usePersonalLists(
  uid: string | undefined,
  options: PersonalOpts = {}
): ReturnType<typeof useQuery<PersonalList[], Error>> {
  const { enabled: enabledOpt, ...rest } = options;
  return useQuery({
    queryKey: ["personalLists", uid],
    queryFn: () => (uid ? getPersonalLists(uid) : Promise.resolve([])),
    enabled: Boolean(uid) && enabledOpt !== false,
    staleTime: 10 * 60 * 1000,
    ...rest,
  });
}

type SharedOpts = Omit<UseQueryOptions<SharedList[], Error>, "queryKey" | "queryFn" | "enabled"> & {
  enabled?: boolean;
};

export function useSharedLists(
  uid: string | undefined,
  options: SharedOpts = {}
): ReturnType<typeof useQuery<SharedList[], Error>> {
  const { enabled: enabledOpt, ...rest } = options;
  return useQuery({
    queryKey: ["sharedLists", uid],
    queryFn: () => (uid ? getSharedListsForUser(uid) : Promise.resolve([])),
    enabled: Boolean(uid) && enabledOpt !== false,
    staleTime: 5 * 60 * 1000,
    ...rest,
  });
}

export function invalidateUserListQueries(
  queryClient: QueryClient,
  uid: string | undefined
): Promise<void> | void {
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

export function useInvalidateUserListQueries(): (uid: string | undefined) => void {
  const queryClient = useQueryClient();
  return (uid) => {
    void invalidateUserListQueries(queryClient, uid);
  };
}

/**
 * Subscribes to favorites for the current list in real time.
 * Returns a Set<string> of favorited registryIds scoped to that list.
 * Personal list favorites are private; shared list favorites are shared across all members.
 */
export function useFavorites(uid: string | undefined, listMode: ListMode | undefined): Set<string> {
  const queryClient = useQueryClient();
  const modeKey = listModeQueryKey(listMode);
  const modeKeyStr = modeKey.join("\0");

  useEffect(() => {
    if (!uid || !listMode) return;
    const unsub = subscribeFavorites(uid, listMode, (favorites) => {
      queryClient.setQueryData(["favorites", uid, ...modeKey], favorites);
    });
    return unsub;
    // modeKeyStr is a stable string representation of listMode for the dep array;
    // modeKey is captured at the time the effect runs and is consistent with modeKeyStr.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, modeKeyStr, queryClient]);

  const { data } = useQuery({
    queryKey: ["favorites", uid, ...modeKey],
    queryFn: () => getFavorites(uid!, listMode!),
    enabled: Boolean(uid) && Boolean(listMode),
    staleTime: 60 * 1000,
  });

  return data ?? new Set<string>();
}
