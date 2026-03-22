import { GENRE_LIMIT } from "../store/watchlistConstants.js";

/**
 * @param {unknown[]} movies
 * @param {string} genre
 */
export function isGenrePresentInMovies(movies, genre) {
  if (!genre) return true;
  const g = genre.toLowerCase();
  return (movies || []).some((m) => {
    const gs = String(m?.genre || "");
    return gs.split(/\s*\/\s*/).some((s) => s.trim().toLowerCase() === g);
  });
}

/**
 * @param {unknown[]} movies
 */
export function getUniqueGenresFromMovies(movies) {
  const count = new Map();
  (movies || []).forEach((m) => {
    const g = String(m?.genre || "").trim();
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

/**
 * Pure filter pipeline for the grid (type, status, genre, recently-added).
 * @param {unknown[]} movies
 * @param {{ currentFilter: string, currentGenre: string, currentStatus: string }} filters
 */
export function filterTitles(movies, { currentFilter, currentGenre, currentStatus }) {
  const listMovies = movies || [];

  if (currentStatus === "recently-added") {
    const recent = [];
    for (let i = listMovies.length - 1; i >= 0 && recent.length < 10; i--) {
      const m = listMovies[i];
      if (currentFilter !== "both" && m.type !== currentFilter) continue;
      if (currentGenre) {
        const g = String(m.genre || "");
        if (
          !g.split(/\s*\/\s*/).some((s) => s.trim().toLowerCase() === currentGenre.toLowerCase())
        ) {
          continue;
        }
      }
      recent.push(m);
    }
    return recent;
  }

  let list =
    currentFilter === "both" ? listMovies : listMovies.filter((m) => m.type === currentFilter);
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
