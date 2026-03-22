import { movieKey, getPersonalListMovies } from "../../firebase.js";

/**
 * Which list ids contain this movie (personal ids include `"personal"`).
 * Resolves which list ids contain a title (personal lists via full fetch; shared via embedded `items`).
 *
 * @param {object} m — hydrated movie row
 * @param {string} uid
 * @param {any[]} personalLists — from `getPersonalLists`
 * @param {any[]} sharedLists — from `getSharedListsForUser` (must include `items` rows)
 */
export async function getListsContainingMovie(m, uid, personalLists, sharedLists) {
  if (!uid || !m) return new Set();
  const key = movieKey(m);
  const containing = new Set();
  for (const l of personalLists) {
    const listId = l.id;
    try {
      const listMovies = await getPersonalListMovies(uid, listId);
      if (listMovies.some((x) => movieKey(x) === key)) containing.add(listId);
    } catch {
      /* ignore per-list errors */
    }
  }
  for (const l of sharedLists) {
    const items = Array.isArray(l.items) ? l.items : [];
    if (items.some((row) => movieKey(row) === key)) containing.add(l.id);
  }
  return containing;
}
