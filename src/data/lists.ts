import type { User } from "firebase/auth";
import { getPersonalListMovies, getSharedListMovies, movieKey } from "../firebase.js";
import { displayListName } from "../lib/utils.js";
import type { ListMode, PersonalList, SharedList, WatchlistItem } from "../types/index.js";

export function getCurrentListValue(listMode: ListMode, _personalLists: PersonalList[]): string {
  if (listMode === "personal") return "personal";
  if (listMode && typeof listMode === "object" && listMode.type === "personal") return listMode.listId;
  if (listMode && typeof listMode === "object" && listMode.type === "shared") return listMode.listId;
  return "personal";
}

/** Human label for the active list (header / trailer modal). */
export function getCurrentListLabel(
  mode: ListMode,
  personalLists: PersonalList[],
  sharedLists: SharedList[]
): string {
  if (mode === "personal") {
    const p = personalLists.find((l) => l.id === "personal");
    return displayListName(p?.name);
  }
  if (mode && typeof mode === "object" && mode.type === "personal") {
    const p = personalLists.find((l) => l.id === mode.listId);
    return displayListName(p?.name ?? mode.name);
  }
  if (mode && typeof mode === "object" && mode.type === "shared") {
    return displayListName(mode.name);
  }
  const main = personalLists.find((l) => l.id === "personal");
  return displayListName(main?.name);
}

export async function loadList(user: User, listMode: ListMode): Promise<WatchlistItem[]> {
  const uid = user.uid;
  if (listMode === "personal" || (listMode && typeof listMode === "object" && listMode.type === "personal")) {
    const listId = listMode === "personal" ? "personal" : listMode.listId;
    try {
      return await getPersonalListMovies(uid, listId);
    } catch (e) {
      console.error("loadList (personal):", e);
      return [];
    }
  }
  if (listMode && typeof listMode === "object" && listMode.type === "shared") {
    try {
      return await getSharedListMovies(listMode.listId);
    } catch (e) {
      console.error("loadList (shared):", e);
      return [];
    }
  }
  return [];
}

/**
 * Which list ids contain this movie (personal ids include `"personal"`).
 * Shared list membership uses embedded `items` on each `SharedList` row (no extra fetch).
 */
export async function getListsContainingMovie(
  movie: WatchlistItem,
  personalLists: PersonalList[],
  sharedLists: SharedList[],
  uid: string
): Promise<Set<string>> {
  if (!uid || !movie) return new Set();
  const key = movieKey(movie);
  const containing = new Set<string>();
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
