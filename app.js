import {
  auth,
  onAuthStateChanged,
  getSharedList,
  getSharedListsForUser,
  createPersonalList,
  getPersonalLists,
  renamePersonalList,
  getUserProfile,
  setUserCountry,
} from "./firebase.js";
import {
  movies,
  setMovies,
  currentFilter,
  setCurrentFilter,
  currentGenre,
  setCurrentGenre,
  currentStatus,
  setCurrentStatus,
  currentListMode,
  setCurrentListMode,
  sharedLists,
  setSharedLists,
  personalLists,
  setPersonalLists,
  setUserCountryCode,
} from "./src/store/state.js";
import {
  saveLastList,
  getLastList,
  loadFilterPreferences,
  saveFilterPreferences,
} from "./src/lib/storage.js";
import { listHandlerBridge } from "./src/data/list-handlers-bridge.js";
import { loadList, setBookmarkletCookie } from "./src/data/lists.js";
import {
  updateFilterCount,
  syncFiltersAfterListLoad,
  renderGenreFilter,
} from "./src/ui/filters.js";
import { buildCards } from "./src/ui/cards.js";
import { openModal, closeModal, updateModalStatusBtn, wireTrailerModalListeners } from "./src/ui/trailer-modal.js";
import { showListNameModal, wireListsManagementListeners } from "./src/ui/lists-modals.js";
import { showCountryModal, updateCountryDropdownRow } from "./src/ui/country-modal.js";
import { clearUpcomingAlertsBar, afterMoviesReloaded } from "./src/ui/upcoming.js";
import {
  renderListSelector,
  updateCopyInviteButton,
  wireListSelectorAndCopyInvite,
  wireGlobalEscapeListeners,
  wireFileProtocolBanner,
} from "./src/ui/header.js";
import { updateAuthUI, wireAuthListeners } from "./src/ui/auth.js";

wireTrailerModalListeners();
wireFileProtocolBanner();
wireAuthListeners();

// Type filter (Both / Movies / Series)
document.querySelectorAll('input[name="typeFilter"]').forEach((input) => {
  input.addEventListener("change", (e) => {
    setCurrentFilter(e.target.value);
    saveFilterPreferences(auth.currentUser);
    buildCards();
  });
});

// Tabs (To Watch / Watched / Recently Added)
document.querySelectorAll(".tab-group .tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    setCurrentStatus(btn.dataset.status);
    document.querySelectorAll(".tab-group .tab").forEach((b) => {
      const isActive = b === btn;
      b.classList.toggle("active", isActive);
      b.setAttribute("aria-selected", isActive ? "true" : "false");
    });
    saveFilterPreferences(auth.currentUser);
    buildCards();
  });
});

// Auth state + load user's movies (each account has its own list)
function init() {
  const grid = document.getElementById("grid");
  grid.innerHTML = '<div class="empty-state">Loading…</div>';

  const joinListId = new URLSearchParams(window.location.search).get("join");

  onAuthStateChanged(auth, async (user) => {
    updateAuthUI(user);
    if (!user) {
      setCurrentListMode("personal");
      setSharedLists([]);
      setMovies([]);
      setUserCountryCode("IL");
      setCurrentFilter("both");
      setCurrentGenre("");
      setCurrentStatus("to-watch");
      clearUpcomingAlertsBar();
      const wrap = document.getElementById("list-selector-wrap");
      if (wrap) wrap.style.display = "none";
      updateFilterCount("");
      grid.innerHTML = '<div class="empty-state">Sign in to see your watchlist.</div>';
      return;
    }

    let profile = { country: null, countryName: null };
    try {
      profile = await getUserProfile(user.uid);
    } catch (e) {
      console.warn("getUserProfile failed:", e);
    }

    if (!profile.country) {
      grid.innerHTML = '<div class="empty-state">Loading…</div>';
      const result = await showCountryModal({
        initialCode: "IL",
        onSave: async (code, name) => {
          await setUserCountry(user.uid, code, name);
          setUserCountryCode(code);
          updateCountryDropdownRow();
        },
      });
      setUserCountryCode(result?.code || "IL");
      updateCountryDropdownRow();
    } else {
      setUserCountryCode(profile.country);
      updateCountryDropdownRow();
    }

    try {
      profile = await getUserProfile(user.uid);
    } catch (e) {
      console.warn("getUserProfile refresh failed:", e);
    }
    if (!String(profile.listName || "").trim()) {
      grid.innerHTML = '<div class="empty-state">Loading…</div>';
      try {
        const mainName = await showListNameModal({
          title: "Name your main list",
          placeholder: "e.g. My weekend watchlist",
          initialValue: "",
          allowCancel: false,
        });
        await renamePersonalList(user.uid, "personal", mainName);
      } catch (e) {
        console.warn("Main list name step failed:", e);
        alert(e?.message || "Could not save your main list name. Reload and try again.");
      }
    }

    try {
      setSharedLists(await getSharedListsForUser(user.uid));
    } catch (e) {
      setSharedLists([]);
    }
    try {
      setPersonalLists(await getPersonalLists(user.uid));
    } catch (e) {
      console.warn("getPersonalLists failed, using default:", e);
      setPersonalLists([{ id: "personal", name: "", count: 0, isDefault: true }]);
    }

    const wrap = document.getElementById("list-selector-wrap");
    if (wrap) wrap.style.display = "flex";

    if (joinListId) {
      const apiBase = window.location.origin;
      try {
        const res = await fetch(apiBase + "/.netlify/functions/join-shared-list", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ listId: joinListId }),
        });
        const data = await res.json();
        if (data.ok) {
          setSharedLists(await getSharedListsForUser(user.uid));
          setCurrentListMode({ type: "shared", listId: joinListId, name: data.name });
          saveLastList(user, currentListMode);
        } else if (data.error) {
          console.warn("Join failed:", data.error);
          alert(data.error);
        }
      } catch (e) {
        console.warn("Join failed:", e);
      }
    } else {
      const last = getLastList(user);
      if (last === "personal") {
        setCurrentListMode("personal");
      } else if (last) {
        const personalList = personalLists.find((l) => l.id === last);
        if (personalList) {
          setCurrentListMode(last === "personal" ? "personal" : { type: "personal", listId: last, name: personalList.name });
        } else {
          let list = sharedLists.find((l) => l.id === last);
          if (!list) {
            try {
              const fetched = await getSharedList(last);
              if (fetched && (fetched.ownerId === user.uid || (Array.isArray(fetched.members) && fetched.members.includes(user.uid)))) {
                setSharedLists([...sharedLists, fetched]);
                list = fetched;
              }
            } catch (_) {}
          }
          if (list) {
            setCurrentListMode({ type: "shared", listId: list.id, name: list.name });
          }
        }
      }
    }

    renderListSelector();
    updateCopyInviteButton();

    loadFilterPreferences(user);
    setMovies(await loadList(user));
    syncFiltersAfterListLoad(user);
    setBookmarkletCookie(user);

    if (!movies.length) {
      const filters = document.getElementById("content-filters");
      if (filters) filters.style.display = "none";
      updateFilterCount(0);
      const isShared = typeof currentListMode === "object" && currentListMode?.type === "shared";
      grid.innerHTML = isShared
        ? '<div class="empty-state">This shared list is empty. Add titles from <a href="./bookmarklet.html">IMDb</a>.</div>'
        : '<div class="empty-state">Your list is empty. Add titles from <a href="./bookmarklet.html">IMDb</a>.</div>';
    } else {
      const filters = document.getElementById("content-filters");
      if (filters) filters.style.display = "";
      buildCards();
      renderGenreFilter();
    }
    updateCopyInviteButton();
    await afterMoviesReloaded(user);
  });

  wireListSelectorAndCopyInvite();
  wireGlobalEscapeListeners();
  wireListsManagementListeners();
}

Object.assign(listHandlerBridge, {
  syncFiltersAfterListLoad,
  buildCards,
  renderGenreFilter,
  updateFilterCount,
  updateCopyInviteButton,
  afterMoviesReloaded,
  renderListSelector,
  openModal,
  closeModal,
  updateModalStatusBtn,
});

init();

