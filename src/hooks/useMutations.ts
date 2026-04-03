import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { invalidateUserListQueries, listModeQueryKey } from "./useWatchlist.js";
import { addTitleToList, removeTitleFromList, setTitleStatus } from "../data/titles.js";
import { auth, listKey, removeFromPersonalList, removeFromSharedList, toggleFavorite } from "../firebase.js";
import type {
  ListMode,
  PersonalList,
  SharedList,
  StatusKey,
  WatchlistItem,
} from "../types/index.js";

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

/** Debounce invalidation so rapid shared-list actions coalesce (was 5min, which hid merged avatars). */
const SHARED_SYNC_DEBOUNCE_MS = 400;
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
    watchlistQueries: queryClient.getQueriesData<WatchlistItem[]>({
      queryKey: ["watchlistMovies", uid],
    }),
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
    const base = prev ?? [];
    const next = updater(base);
    changed = next !== base;
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
    return prev.map((l) =>
      l.id === listId ? { ...l, count: Math.max(0, (l.count || 0) + delta) } : l
    );
  });
}

/** Trailer modal "lists containing this title" — keep in sync with optimistic watchlist cache updates. */
function patchListsContainingQueries(
  queryClient: QueryClient,
  uid: string,
  listKeyStr: string,
  updater: (set: Set<string>) => void
): void {
  for (const query of queryClient.getQueryCache().findAll({
    predicate: (q) => {
      const k = q.queryKey;
      return Array.isArray(k) && k[0] === "listsContaining" && k[1] === listKeyStr && k[2] === uid;
    },
  })) {
    const prev = query.state.data;
    const set = prev instanceof Set ? new Set(prev) : new Set<string>();
    updater(set);
    queryClient.setQueryData(query.queryKey, set);
  }
}

function invalidateListsContainingForMovie(
  queryClient: QueryClient,
  uid: string,
  listKeyStr: string
): void {
  void queryClient.invalidateQueries({
    predicate: (q) => {
      const k = q.queryKey;
      return Array.isArray(k) && k[0] === "listsContaining" && k[1] === listKeyStr && k[2] === uid;
    },
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
          if (listKey(m) !== key) return m;
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
    mutationFn: ({ uid, listMode, key }: RemoveTitleVars) =>
      removeTitleFromList(uid, listMode, key),
    onMutate: async ({ uid, listMode, key }) => {
      await queryClient.cancelQueries({ queryKey: ["watchlistMovies", uid] });
      const snapshot = captureSnapshot(queryClient, uid);
      const removed = updateWatchlistCacheForMode(queryClient, uid, listMode, (prev) => {
        const next = prev.filter((m) => listKey(m) !== key);
        return next.length === prev.length ? prev : next;
      });
      const info = modeToListInfo(listMode);
      if (removed && info.type === "personal") {
        updateListCountOptimistically(queryClient, uid, info.listId, -1);
      }
      /* Checkmarks can come from shared metadata while watchlist cache is still empty — always clear containing. */
      patchListsContainingQueries(queryClient, uid, key, (s) => {
        s.delete(info.listId);
      });
      return snapshot;
    },
    onError: (_err, vars, snapshot) => {
      restoreSnapshot(queryClient, snapshot);
      invalidateListsContainingForMovie(queryClient, vars.uid, vars.key);
    },
    onSuccess: (_, { uid, listMode }) => {
      if (isSharedMode(listMode)) {
        scheduleSharedBackgroundSync(queryClient, uid);
      }
    },
  });
}

function enrichItemForSharedAdd(
  uid: string,
  listMode: ListMode,
  item: WatchlistItem
): WatchlistItem {
  if (!isSharedMode(listMode)) return item;
  const u = auth.currentUser;
  if (u?.uid !== uid) return { ...item, addedByUid: uid };
  const dn = u.displayName?.trim() || (u.email ? u.email.split("@")[0] : "") || "";
  const photo = u.photoURL?.trim() || "";
  return {
    ...item,
    addedByUid: uid,
    ...(dn ? { addedByDisplayName: dn } : {}),
    ...(photo ? { addedByPhotoUrl: photo } : {}),
  };
}

export function useAddTitleToList() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ uid, listMode, item }: AddTitleToListVars) =>
      addTitleToList(uid, listMode, item),
    onMutate: async ({ uid, listMode, item }) => {
      await queryClient.cancelQueries({ queryKey: ["watchlistMovies", uid] });
      const snapshot = captureSnapshot(queryClient, uid);
      const itemForCache = enrichItemForSharedAdd(uid, listMode, item);
      const added = updateWatchlistCacheForMode(queryClient, uid, listMode, (prev) => {
        const key = listKey(itemForCache);
        if (prev.some((m) => listKey(m) === key)) return prev;
        return [...prev, itemForCache];
      });
      if (added) {
        const info = modeToListInfo(listMode);
        if (info.type === "personal") {
          updateListCountOptimistically(queryClient, uid, info.listId, 1);
        }
        patchListsContainingQueries(queryClient, uid, listKey(itemForCache), (s) => {
          s.add(info.listId);
        });
      }
      return snapshot;
    },
    onError: (_err, vars, snapshot) => {
      restoreSnapshot(queryClient, snapshot);
      invalidateListsContainingForMovie(queryClient, vars.uid, listKey(vars.item));
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
      type === "personal"
        ? removeFromPersonalList(uid, listId, key)
        : removeFromSharedList(listId, key),
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
        const next = prev.filter((m) => listKey(m) !== key);
        return next.length === prev.length ? prev : next;
      });
      if (removed && type === "personal") {
        updateListCountOptimistically(queryClient, uid, listId, -1);
      }
      /* Same as useRemoveTitle: trailer checkmarks may use sharedLists.items without a hydrated watchlist query. */
      patchListsContainingQueries(queryClient, uid, key, (s) => {
        s.delete(listId);
      });
      return snapshot;
    },
    onError: (_err, vars, snapshot) => {
      restoreSnapshot(queryClient, snapshot);
      invalidateListsContainingForMovie(queryClient, vars.uid, vars.key);
    },
    onSuccess: (_, { uid, type }) => {
      if (type === "shared") {
        scheduleSharedBackgroundSync(queryClient, uid);
      }
    },
  });
}

interface ToggleFavoriteVars {
  uid: string;
  listMode: ListMode;
  registryId: string;
  isFavorite: boolean;
}

export function useToggleFavorite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ uid, listMode, registryId, isFavorite }: ToggleFavoriteVars) =>
      toggleFavorite(uid, listMode, registryId, isFavorite),
    onMutate: async ({ uid, listMode, registryId, isFavorite }) => {
      const modeKey = listModeQueryKey(listMode);
      const cacheKey = ["favorites", uid, ...modeKey];
      await queryClient.cancelQueries({ queryKey: cacheKey });
      const previous = queryClient.getQueryData<Set<string>>(cacheKey);
      queryClient.setQueryData<Set<string>>(cacheKey, (prev) => {
        const next = new Set(prev ?? []);
        if (isFavorite) next.add(registryId);
        else next.delete(registryId);
        return next;
      });
      return { previous, uid, modeKey };
    },
    onError: (_err, _vars, context) => {
      if (context) {
        queryClient.setQueryData(["favorites", context.uid, ...context.modeKey], context.previous);
      }
    },
  });
}
