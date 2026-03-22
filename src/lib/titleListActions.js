import {
  movieKey,
  removeFromPersonalList,
  removeFromSharedList,
  removeTitle,
  setPersonalListStatus,
  setSharedListStatus,
  setStatus,
} from "../../firebase.js";

/**
 * @param {string} uid
 * @param {unknown} listMode — same shapes as Zustand `currentListMode`
 * @param {object} movie
 * @param {string} status
 */
export async function persistTitleStatus(uid, listMode, movie, status) {
  const key = movieKey(movie);
  if (listMode?.type === "shared") {
    await setSharedListStatus(listMode.listId, key, status);
    return;
  }
  if (listMode?.type === "personal") {
    await setPersonalListStatus(uid, listMode.listId, key, status);
    return;
  }
  await setStatus(uid, key, status);
}

/**
 * @param {string} uid
 * @param {unknown} listMode
 * @param {object} movie
 */
export async function persistRemoveTitle(uid, listMode, movie) {
  const key = movieKey(movie);
  if (listMode?.type === "shared") {
    await removeFromSharedList(listMode.listId, key);
    return;
  }
  if (listMode?.type === "personal") {
    await removeFromPersonalList(uid, listMode.listId, key);
    return;
  }
  await removeTitle(uid, key);
}
