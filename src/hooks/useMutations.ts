import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { invalidateUserListQueries, listModeQueryKey } from "./useWatchlist.js";
import { addTitleToList, removeTitleFromList, setTitleStatus } from "../data/titles.js";
import { movieKey, removeFromPersonalList, removeFromSharedList } from "../firebase.js";
import type { ListMode, PersonalList, SharedList, StatusKey, WatchlistItem } from "../types/index.js";

interface SetTitleStatusVars {
  uid: string;
  listMode: ListMode;
  key: string;
  status: StatusKey;
}

interface RemoveTitleVars {
  uid: string;
  listMode: ListMode;
  key: string;
}

interface AddTitleToListVars {
  uid: string;
  listMode: ListMode;
  item: WatchlistItem;
}

interface RemoveTitleFromListVars {
  uid: string;
  listId: string;
  key: string;
  type: "personal" | "shared";
}

type MutationSnapshot = {
  uid: string;
  watchlistQueries: Array<[QueryKey, WatchlistItem[] | undefined]>;
  personalLists: PersonalList[] | undefined;
  sharedLists: SharedList[] | undefined;
};

const SHARED_SYNC_DEBOUNCE_MS = 5 * 60 * 1000;
const sharedSyncTimers = new Map<string, number>();

function isSharedMode(listMode: ListMode): boolean {
  return typeof listMode === "object" && listMode.type === "shared";
}

function modeToListInfo(listMode: ListMode): { type: "personal" | "shared"; listId: string } {
  if (typeof listMode === "object" && listMode.type === "shared") {
    return { type: "shared", listId: listMode.listId };
  }
  if (typeof listMode === "object" && listMode.type === "personal") {
    return { type: "personal", listId: listMode.listId };
  }
  return { type: "personal", listId: "personal" };
}

function captureSnapshot(queryClient: QueryClient, uid: string): MutationSnapshot {
  return {
    uid,
    watchlistQueries: queryClient.getQueriesData<WatchlistItem[]>({ queryKey: ["watchlistMovies", uid] }),
    personalLists: queryClient.getQueryData<PersonalList[]>(["personalLists", uid]),
    sharedLists: queryClient.getQueryData<SharedList[]>(["sharedLists", uid]),
  };
}

function restoreSnapshot(queryClient: QueryClient, snapshot: MutationSnapshot | undefined): void {
  if (!snapshot) return;
  for (const [key, data] of snapshot.watchlistQueries) {
    queryClient.setQueryData(key, data);
  }
  queryClient.setQueryData(["personalLists", snapshot.uid], snapshot.personalLists);
  queryClient.setQueryData(["sharedLists", snapshot.uid], snapshot.sharedLists);
}

function updateWatchlistCacheForMode(
  queryClient: QueryClient,
  uid: string,
  listMode: ListMode,
  updater: (items: WatchlistItem[]) => WatchlistItem[]
): boolean {
  const modeKey = listModeQueryKey(listMode);
  const key: QueryKey = ["watchlistMovies", uid, ...modeKey];
  let changed = false;
  queryClient.setQueryData<WatchlistItem[]>(key, (prev) => {
    if (!prev) return prev;
    const next = updater(prev);
    changed = next !== prev;
    return next;
  });
  return changed;
}

function scheduleSharedBackgroundSync(queryClient: QueryClient, uid: string): void {
  const existing = sharedSyncTimers.get(uid);
  if (existing) window.clearTimeout(existing);
  const timerId = window.setTimeout(() => {
    sharedSyncTimers.delete(uid);
    void invalidateUserListQueries(queryClient, uid);
  }, SHARED_SYNC_DEBOUNCE_MS);
  sharedSyncTimers.set(uid, timerId);
}

function updateListCountOptimistically(
  queryClient: QueryClient,
  uid: string,
  listId: string,
  delta: number
): void {
  queryClient.setQueryData<PersonalList[]>(["personalLists", uid], (prev) => {
    if (!prev) return prev;
    return prev.map((l) => (l.id === listId ? { ...l, count: Math.max(0, (l.count || 0) + delta) } : l));
  });
}

export function useSetTitleStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ uid, listMode, key, status }: SetTitleStatusVars) =>
      setTitleStatus(uid, listMode, key, status),
    onMutate: async ({ uid, listMode, key, status }) => {
      await queryClient.cancelQueries({ queryKey: ["watchlistMovies", uid] });
      const snapshot = captureSnapshot(queryClient, uid);
      updateWatchlistCacheForMode(queryClient, uid, listMode, (prev) => {
        let changed = false;
        const next = prev.map((m) => {
          if (movieKey(m) !== key) return m;
          if ((m.status || "to-watch") === status) return m;
          changed = true;
          return { ...m, status };
        });
        return changed ? next : prev;
      });
      return snapshot;
    },
    onError: (_err, _vars, snapshot) => {
      restoreSnapshot(queryClient, snapshot);
    },
    onSuccess: (_, { uid, listMode }) => {
      if (isSharedMode(listMode)) {
        scheduleSharedBackgroundSync(queryClient, uid);
      }
    },
  });
}

export function useRemoveTitle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ uid, listMode, key }: RemoveTitleVars) => removeTitleFromList(uid, listMode, key),
    onMutate: async ({ uid, listMode, key }) => {
      await queryClient.cancelQueries({ queryKey: ["watchlistMovies", uid] });
      const snapshot = captureSnapshot(queryClient, uid);
      const removed = updateWatchlistCacheForMode(queryClient, uid, listMode, (prev) => {
        const next = prev.filter((m) => movieKey(m) !== key);
        return next.length === prev.length ? prev : next;
      });
      if (removed) {
        const info = modeToListInfo(listMode);
        if (info.type === "personal") {
          updateListCountOptimistically(queryClient, uid, info.listId, -1);
        }
      }
      return snapshot;
    },
    onError: (_err, _vars, snapshot) => {
      restoreSnapshot(queryClient, snapshot);
    },
    onSuccess: (_, { uid, listMode }) => {
      if (isSharedMode(listMode)) {
        scheduleSharedBackgroundSync(queryClient, uid);
      }
    },
  });
}

function enrichItemForSharedAdd(uid: string, listMode: ListMode, item: WatchlistItem): WatchlistItem {
  if (!isSharedMode(listMode)) return item;
  return { ...item, addedByUid: uid };
}

export function useAddTitleToList() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ uid, listMode, item }: AddTitleToListVars) => addTitleToList(uid, listMode, item),
    onMutate: async ({ uid, listMode, item }) => {
      await queryClient.cancelQueries({ queryKey: ["watchlistMovies", uid] });
      const snapshot = captureSnapshot(queryClient, uid);
      const itemForCache = enrichItemForSharedAdd(uid, listMode, item);
      const added = updateWatchlistCacheForMode(queryClient, uid, listMode, (prev) => {
        const key = movieKey(itemForCache);
        if (prev.some((m) => movieKey(m) === key)) return prev;
        return [...prev, itemForCache];
      });
      if (added) {
        const info = modeToListInfo(listMode);
        if (info.type === "personal") {
          updateListCountOptimistically(queryClient, uid, info.listId, 1);
        }
      }
      return snapshot;
    },
    onError: (_err, _vars, snapshot) => {
      restoreSnapshot(queryClient, snapshot);
    },
    onSuccess: (_, { uid, listMode }) => {
      if (isSharedMode(listMode)) {
        scheduleSharedBackgroundSync(queryClient, uid);
      }
    },
  });
}

export function useRemoveTitleFromList() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ uid, listId, key, type }: RemoveTitleFromListVars) =>
      type === "personal" ? removeFromPersonalList(uid, listId, key) : removeFromSharedList(listId, key),
    onMutate: async ({ uid, listId, key, type }) => {
      await queryClient.cancelQueries({ queryKey: ["watchlistMovies", uid] });
      const snapshot = captureSnapshot(queryClient, uid);
      const targetMode: ListMode =
        type === "shared"
          ? { type: "shared", listId, name: "" }
          : listId === "personal"
            ? "personal"
            : { type: "personal", listId };
      const removed = updateWatchlistCacheForMode(queryClient, uid, targetMode, (prev) => {
        const next = prev.filter((m) => movieKey(m) !== key);
        return next.length === prev.length ? prev : next;
      });
      if (removed) {
        if (type === "personal") {
          updateListCountOptimistically(queryClient, uid, listId, -1);
        }
      }
      return snapshot;
    },
    onError: (_err, _vars, snapshot) => {
      restoreSnapshot(queryClient, snapshot);
    },
    onSuccess: (_, { uid, type }) => {
      if (type === "shared") {
        scheduleSharedBackgroundSync(queryClient, uid);
      }
    },
  });
}
