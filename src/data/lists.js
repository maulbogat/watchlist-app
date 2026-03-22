import {
  auth,
  movieKey,
  getPersonalListMovies,
  getSharedListMovies,
  getBookmarkletPersonalListFirestoreId,
} from "../../firebase.js";
import {
  currentListMode,
  setCurrentListMode,
  movies,
  setMovies,
  personalLists,
  sharedLists,
} from "../store/state.js";
import { saveLastList } from "../lib/storage.js";
import { displayListName } from "../lib/utils.js";
import { listHandlerBridge } from "./list-handlers-bridge.js";

async function setBookmarkletCookie(user) {
  if (window.location.protocol !== "https:") return;
  try {
    if (!user) {
      document.cookie = "bookmarklet_token=; path=/; max-age=0";
      document.cookie = "bookmarklet_list_id=; path=/; max-age=0";
      document.cookie = "bookmarklet_personal_list_id=; path=/; max-age=0";
      return;
    }
    const token = await user.getIdToken();
    document.cookie = `bookmarklet_token=${token}; path=/; max-age=2592000; SameSite=None; Secure`;
    if (typeof currentListMode === "object" && currentListMode?.type === "shared") {
      document.cookie = `bookmarklet_list_id=${encodeURIComponent(currentListMode.listId)}; path=/; max-age=2592000; SameSite=None; Secure`;
      document.cookie = "bookmarklet_personal_list_id=; path=/; max-age=0";
    } else {
      document.cookie = "bookmarklet_list_id=; path=/; max-age=0";
      const listId =
        currentListMode === "personal"
          ? "personal"
          : typeof currentListMode === "object" && currentListMode?.type === "personal"
            ? currentListMode.listId
            : "personal";
      const pid = await getBookmarkletPersonalListFirestoreId(user.uid, listId);
      if (pid) {
        document.cookie = `bookmarklet_personal_list_id=${encodeURIComponent(pid)}; path=/; max-age=2592000; SameSite=None; Secure`;
      } else {
        document.cookie = "bookmarklet_personal_list_id=; path=/; max-age=0";
      }
    }
  } catch (e) {
    console.warn("Bookmarklet cookie:", e);
  }
}

async function loadList(user) {
  const grid = document.getElementById("grid");
  if (currentListMode === "personal" || (typeof currentListMode === "object" && currentListMode?.type === "personal")) {
    const listId = currentListMode === "personal" ? "personal" : currentListMode.listId;
    try {
      setMovies(await getPersonalListMovies(user.uid, listId));
    } catch (e) {
      console.error("Failed to load your list:", e);
      setMovies([]);
    }
  } else if (typeof currentListMode === "object" && currentListMode?.type === "shared") {
    try {
      setMovies(await getSharedListMovies(currentListMode.listId));
    } catch (e) {
      console.error("Failed to load shared list:", e);
      setMovies([]);
    }
  } else {
    setMovies([]);
  }
  return movies;
}

function getCurrentListValue() {
  if (currentListMode === "personal") return "personal";
  if (typeof currentListMode === "object" && currentListMode?.type === "personal") return currentListMode.listId;
  if (typeof currentListMode === "object" && currentListMode?.type === "shared") return currentListMode.listId;
  return "personal";
}

function getCurrentListLabel() {
  if (currentListMode === "personal") {
    const p = personalLists.find((l) => l.id === "personal");
    return displayListName(p?.name);
  }
  if (typeof currentListMode === "object" && currentListMode?.type === "personal") {
    const p = personalLists.find((l) => l.id === currentListMode.listId);
    return displayListName(p?.name ?? currentListMode.name);
  }
  if (typeof currentListMode === "object" && currentListMode?.type === "shared") {
    return displayListName(currentListMode.name);
  }
  const main = personalLists.find((l) => l.id === "personal");
  return displayListName(main?.name);
}

async function getListsContainingMovie(m) {
  const user = auth.currentUser;
  if (!user) return new Set();
  const key = movieKey(m);
  const containing = new Set();
  for (const l of personalLists) {
    const listId = l.id;
    try {
      const listMovies = await getPersonalListMovies(user.uid, listId);
      if (listMovies.some((x) => movieKey(x) === key)) containing.add(listId);
    } catch (_) {}
  }
  for (const l of sharedLists) {
    const items = Array.isArray(l.items) ? l.items : [];
    if (items.some((x) => movieKey(x) === key)) containing.add(l.id);
  }
  return containing;
}

async function handleListSelect(val) {
  const user = auth.currentUser;
  if (!user) return;
  const grid = document.getElementById("grid");
  const filters = document.getElementById("content-filters");

  const personalList = personalLists.find((l) => l.id === val);
  const sharedList = sharedLists.find((l) => l.id === val);

  if (personalList) {
    setCurrentListMode(val === "personal" ? "personal" : { type: "personal", listId: val, name: personalList.name });
    saveLastList(user, currentListMode);
    setMovies(await loadList(user));
    listHandlerBridge.syncFiltersAfterListLoad(user);
    setBookmarkletCookie(user);
    if (!movies.length) {
      if (filters) filters.style.display = "none";
      listHandlerBridge.updateFilterCount(0);
      if (grid) grid.innerHTML = '<div class="empty-state">Your list is empty. Add titles from <a href="./bookmarklet.html">IMDb</a>.</div>';
    } else {
      if (filters) filters.style.display = "";
      listHandlerBridge.buildCards();
      listHandlerBridge.renderGenreFilter();
    }
    listHandlerBridge.updateCopyInviteButton();
  } else if (sharedList) {
    setCurrentListMode({ type: "shared", listId: sharedList.id, name: sharedList.name });
    saveLastList(user, currentListMode);
    setMovies(await loadList(user));
    listHandlerBridge.syncFiltersAfterListLoad(user);
    setBookmarkletCookie(user);
    const filters = document.getElementById("content-filters");
    if (filters) filters.style.display = movies.length ? "" : "none";
    if (movies.length) {
      listHandlerBridge.buildCards();
      listHandlerBridge.renderGenreFilter();
    } else {
      listHandlerBridge.updateFilterCount(0);
      if (grid) grid.innerHTML = '<div class="empty-state">This shared list is empty.</div>';
    }
    listHandlerBridge.updateCopyInviteButton();
  } else {
    setCurrentListMode("personal");
    saveLastList(user, currentListMode);
    setMovies(await loadList(user));
    listHandlerBridge.syncFiltersAfterListLoad(user);
    setBookmarkletCookie(user);
    if (filters) filters.style.display = movies.length ? "" : "none";
    if (movies.length) {
      listHandlerBridge.buildCards();
      listHandlerBridge.renderGenreFilter();
    } else {
      listHandlerBridge.updateFilterCount(0);
      if (grid) grid.innerHTML = '<div class="empty-state">Your list is empty. Add titles from <a href="./bookmarklet.html">IMDb</a>.</div>';
    }
    listHandlerBridge.updateCopyInviteButton();
  }
  await listHandlerBridge.afterMoviesReloaded(user);
  listHandlerBridge.renderListSelector();
}

export {
  setBookmarkletCookie,
  loadList,
  getCurrentListValue,
  getCurrentListLabel,
  getListsContainingMovie,
  handleListSelect,
};
