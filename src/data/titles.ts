import {
  addToPersonalList,
  addToSharedList,
  listKey,
  removeFromPersonalList,
  removeFromSharedList,
  removeTitle,
  setPersonalListStatus,
  setSharedListStatus,
  setStatus,
} from "../firebase.js";
import type { ListMode, StatusKey, WatchlistItem } from "../types/index.js";

export async function addTitleToList(
  uid: string,
  listMode: ListMode,
  item: WatchlistItem
): Promise<void> {
  if (typeof listMode === "object" && listMode.type === "shared") {
    await addToSharedList(listMode.listId, item, uid);
    return;
  }
  if (typeof listMode === "object" && listMode.type === "personal") {
    await addToPersonalList(uid, listMode.listId, item);
    return;
  }
  await addToPersonalList(uid, "personal", item);
}

export async function removeTitleFromList(
  uid: string,
  listMode: ListMode,
  key: string
): Promise<void> {
  if (typeof listMode === "object" && listMode.type === "shared") {
    await removeFromSharedList(listMode.listId, key);
    return;
  }
  if (typeof listMode === "object" && listMode.type === "personal") {
    await removeFromPersonalList(uid, listMode.listId, key);
    return;
  }
  await removeTitle(uid, key);
}

export async function setTitleStatus(
  uid: string,
  listMode: ListMode,
  key: string,
  status: StatusKey
): Promise<void> {
  if (typeof listMode === "object" && listMode.type === "shared") {
    await setSharedListStatus(listMode.listId, key, status);
    return;
  }
  if (typeof listMode === "object" && listMode.type === "personal") {
    await setPersonalListStatus(uid, listMode.listId, key, status);
    return;
  }
  await setStatus(uid, key, status);
}

/** Convenience: set status from a hydrated row (uses `listKey`). */
export async function setTitleStatusForMovie(
  uid: string,
  listMode: ListMode,
  movie: WatchlistItem,
  status: StatusKey
): Promise<void> {
  return setTitleStatus(uid, listMode, listKey(movie), status);
}

/** Convenience: remove using a hydrated row (uses `listKey`). */
export async function removeTitleFromListForMovie(
  uid: string,
  listMode: ListMode,
  movie: WatchlistItem
): Promise<void> {
  return removeTitleFromList(uid, listMode, listKey(movie));
}
