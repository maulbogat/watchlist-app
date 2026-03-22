import { auth } from "../../firebase.js";
import { saveFilterPreferences } from "../lib/storage.js";
import {
  movies,
  currentFilter,
  currentGenre,
  currentStatus,
  setCurrentGenre,
  GENRE_LIMIT,
} from "../store/state.js";
import { listHandlerBridge } from "../data/list-handlers-bridge.js";

export function isGenrePresentInMovies(genre) {
  if (!genre) return true;
  const g = genre.toLowerCase();
  return movies.some((m) => {
    const gs = String(m.genre || "");
    return gs.split(/\s*\/\s*/).some((s) => s.trim().toLowerCase() === g);
  });
}

export function sanitizeGenreAfterLoad() {
  if (currentGenre && !isGenrePresentInMovies(currentGenre)) setCurrentGenre("");
}

/** Sync type radios + status tabs to currentFilter / currentStatus (e.g. after refresh restore). */
export function applyFilterUI() {
  document.querySelectorAll('input[name="typeFilter"]').forEach((input) => {
    input.checked = input.value === currentFilter;
  });
  document.querySelectorAll(".tab-group .tab").forEach((btn) => {
    const isActive = btn.dataset.status === currentStatus;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
  });
}

export function syncFiltersAfterListLoad(user) {
  sanitizeGenreAfterLoad();
  applyFilterUI();
}

export function getUniqueGenres() {
  const count = new Map();
  movies.forEach((m) => {
    const g = String(m.genre || "").trim();
    if (!g) return;
    g.split(/\s*\/\s*/).forEach((s) => {
      const t = s.trim();
      if (t) count.set(t, (count.get(t) || 0) + 1);
    });
  });
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], undefined, { sensitivity: "base" }))
    .slice(0, GENRE_LIMIT)
    .map(([name]) => name);
}

export function getFilteredTitles() {
  if (currentStatus === "recently-added") {
    // Last 10 items in the loaded list (by array order)
    const recent = [];
    for (let i = movies.length - 1; i >= 0 && recent.length < 10; i--) {
      const m = movies[i];
      if (currentFilter !== "both" && m.type !== currentFilter) continue;
      if (currentGenre) {
        const g = String(m.genre || "");
        if (!g.split(/\s*\/\s*/).some((s) => s.trim().toLowerCase() === currentGenre.toLowerCase())) continue;
      }
      recent.push(m);
    }
    return recent;
  }

  let list = currentFilter === "both" ? movies : movies.filter((m) => m.type === currentFilter);
  list = list.filter((m) => {
    const s = m.status || "to-watch";
    if (currentStatus === "to-watch") return s === "to-watch" || s === "maybe-later";
    if (currentStatus === "archive") return s === "archive";
    return s === currentStatus;
  });
  if (currentGenre) {
    list = list.filter((m) => {
      const g = String(m.genre || "");
      return g.split(/\s*\/\s*/).some((s) => s.trim().toLowerCase() === currentGenre.toLowerCase());
    });
  }

  return [...list].sort((a, b) =>
    String(a.title).localeCompare(String(b.title), undefined, { sensitivity: "base" })
  );
}

export function updateFilterCount(visibleCount) {
  const el = document.getElementById("filter-count");
  if (!el) return;
  el.textContent = typeof visibleCount === "number" ? `${visibleCount} title${visibleCount === 1 ? "" : "s"}` : "";
}

export function renderGenreFilter() {
  const container = document.getElementById("genre-filter-wrap");
  if (!container) return;
  const genres = getUniqueGenres();
  if (!genres.length) {
    container.style.display = "none";
    return;
  }
  container.style.display = "flex";
  container.innerHTML = `
    <button type="button" class="genre-chip ${!currentGenre ? "active" : ""}" data-genre="" aria-pressed="${!currentGenre}">All</button>
    ${genres.map((g) => `<button type="button" class="genre-chip ${currentGenre === g ? "active" : ""}" data-genre="${g}" aria-pressed="${currentGenre === g}">${g}</button>`).join("")}
  `;
  container.querySelectorAll(".genre-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      setCurrentGenre(btn.dataset.genre || "");
      saveFilterPreferences(auth.currentUser);
      container.querySelectorAll(".genre-chip").forEach((b) => {
        const isActive = (b.dataset.genre || "") === currentGenre;
        b.classList.toggle("active", isActive);
        b.setAttribute("aria-pressed", isActive);
      });
      listHandlerBridge.buildCards();
    });
  });
}
