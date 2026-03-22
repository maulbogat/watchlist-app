import { useMutation, useQueryClient } from "@tanstack/react-query";
import { invalidateUserListQueries } from "./useWatchlist.js";
import { addTitleToList, removeTitleFromList, setTitleStatus } from "../data/titles.js";
import { removeFromPersonalList, removeFromSharedList } from "../firebase.js";
import type { ListMode, StatusKey, WatchlistItem } from "../types/index.js";

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

export function useSetTitleStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ uid, listMode, key, status }: SetTitleStatusVars) =>
      setTitleStatus(uid, listMode, key, status),
    onSuccess: async (_, { uid }) => {
      await invalidateUserListQueries(queryClient, uid);
    },
  });
}

export function useRemoveTitle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ uid, listMode, key }: RemoveTitleVars) => removeTitleFromList(uid, listMode, key),
    onSuccess: async (_, { uid }) => {
      await invalidateUserListQueries(queryClient, uid);
    },
  });
}

export function useAddTitleToList() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ uid, listMode, item }: AddTitleToListVars) => addTitleToList(uid, listMode, item),
    onSuccess: async (_, { uid }) => {
      await invalidateUserListQueries(queryClient, uid);
    },
  });
}

export function useRemoveTitleFromList() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ uid, listId, key, type }: RemoveTitleFromListVars) =>
      type === "personal" ? removeFromPersonalList(uid, listId, key) : removeFromSharedList(listId, key),
    onSuccess: async (_, { uid }) => {
      await invalidateUserListQueries(queryClient, uid);
    },
  });
}
