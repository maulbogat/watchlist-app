import { useAppStore, STATUS_LABELS } from "../store/useAppStore.js";
import { persistFilterPreferences } from "../lib/storage.js";
import { getUniqueGenresFromMovies } from "../lib/watchlistFilters.js";
import { logEvent } from "../lib/axiom-logger.js";
import type { FilterType, SortType, WatchlistItem } from "../types/index.js";

interface WatchlistToolbarProps {
  allMovies: WatchlistItem[];
  visibleCount: number;
}

export function WatchlistToolbar({ allMovies, visibleCount }: WatchlistToolbarProps) {
  const currentUser = useAppStore((s) => s.currentUser);
  const currentFilter = useAppStore((s) => s.currentFilter);
  const setCurrentFilter = useAppStore((s) => s.setCurrentFilter);
  const currentGenre = useAppStore((s) => s.currentGenre);
  const setCurrentGenre = useAppStore((s) => s.setCurrentGenre);
  const currentStatus = useAppStore((s) => s.currentStatus);
  const setCurrentStatus = useAppStore((s) => s.setCurrentStatus);
  const currentSort = useAppStore((s) => s.currentSort);
  const setCurrentSort = useAppStore((s) => s.setCurrentSort);
  const currentSearch = useAppStore((s) => s.currentSearch);
  const setCurrentSearch = useAppStore((s) => s.setCurrentSearch);

  const genres = getUniqueGenresFromMovies(allMovies);

  function persistFilters() {
    persistFilterPreferences(currentUser, {
      currentFilter: useAppStore.getState().currentFilter,
      currentGenre: useAppStore.getState().currentGenre,
      currentStatus: useAppStore.getState().currentStatus,
      currentSort: useAppStore.getState().currentSort,
      currentSearch: useAppStore.getState().currentSearch,
    });
  }

  return (
    <div className="content-filters" id="content-filters">
      <div className="tab-group-wrap">
        <div className="tab-group" role="tablist" aria-label="Watch status">
          {[
            { id: "tab-recently-added", status: "recently-added", label: "Recently Added" },
            { id: "tab-to-watch", status: "to-watch", label: STATUS_LABELS["to-watch"] },
            { id: "tab-watched", status: "watched", label: STATUS_LABELS.watched },
            { id: "tab-archive", status: "archive", label: STATUS_LABELS.archive },
          ].map(({ id, status, label }) => {
            const active = currentStatus === status;
            return (
              <button
                key={status}
                type="button"
                id={id}
                className={`tab${active ? " active" : ""}`}
                role="tab"
                aria-selected={active}
                aria-controls="grid"
                data-status={status}
                onClick={() => {
                  setCurrentStatus(status);
                  persistFilters();
                  void logEvent({
                    type: "user.action",
                    action: "filter.change",
                    filterType: "status",
                    value: status,
                    uid: currentUser?.uid ?? null,
                  }).catch(() => {});
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
        <span className="filter-count" id="filter-count" aria-live="polite">
          {typeof visibleCount === "number"
            ? `${visibleCount} title${visibleCount === 1 ? "" : "s"}`
            : ""}
        </span>
      </div>
      <div className="filter-group" role="radiogroup" aria-label="Filter titles">
        {[
          { id: "filter-both", value: "both", label: "Both" },
          { id: "filter-movies", value: "movie", label: "Movies" },
          { id: "filter-shows", value: "show", label: "Series" },
        ].map(({ id, value, label }) => (
          <span key={value}>
            <input
              type="radio"
              name="typeFilter"
              id={id}
              value={value}
              checked={currentFilter === value}
              onChange={() => {
                setCurrentFilter(value as FilterType);
                persistFilters();
                void logEvent({
                  type: "user.action",
                  action: "filter.change",
                  filterType: "type",
                  value,
                  uid: currentUser?.uid ?? null,
                }).catch(() => {});
              }}
            />
            <label htmlFor={id}>{label}</label>
          </span>
        ))}
      </div>
      <div className="sort-wrap">
        <label htmlFor="sort-select">Sort</label>
        <select
          id="sort-select"
          className="sort-select"
          value={currentSort}
          onChange={(e) => {
            const nextSort = e.target.value as SortType;
            setCurrentSort(nextSort);
            persistFilters();
            void logEvent({
              type: "user.action",
              action: "filter.change",
              filterType: "sort",
              value: nextSort,
              uid: currentUser?.uid ?? null,
            }).catch(() => {});
          }}
        >
          <option value="title-asc">Title (A-Z)</option>
          <option value="release-desc">Release Date (New-Old)</option>
        </select>
      </div>
      <div className="search-wrap">
        <label htmlFor="title-search">Search</label>
        <input
          id="title-search"
          type="text"
          className="search-input"
          placeholder="Search titles"
          value={currentSearch}
          onChange={(e) => {
            setCurrentSearch(e.target.value);
            persistFilters();
          }}
          onBlur={() => {
            void logEvent({
              type: "user.action",
              action: "filter.change",
              filterType: "search",
              value: currentSearch.trim() || "empty",
              uid: currentUser?.uid ?? null,
            }).catch(() => {});
          }}
        />
      </div>
      {genres.length ? (
        <div id="genre-filter-wrap" className="genre-filter-wrap" style={{ display: "flex" }}>
          <button
            type="button"
            className={`genre-chip${!currentGenre ? " active" : ""}`}
            data-genre=""
            aria-pressed={!currentGenre}
            onClick={() => {
              setCurrentGenre("");
              persistFilters();
              void logEvent({
                type: "user.action",
                action: "filter.change",
                filterType: "genre",
                value: "all",
                uid: currentUser?.uid ?? null,
              }).catch(() => {});
            }}
          >
            All
          </button>
          {genres.map((g) => {
            const active = currentGenre === g;
            return (
              <button
                key={g}
                type="button"
                className={`genre-chip${active ? " active" : ""}`}
                data-genre={g}
                aria-pressed={active}
                onClick={() => {
                  setCurrentGenre(g);
                  persistFilters();
                  void logEvent({
                    type: "user.action",
                    action: "filter.change",
                    filterType: "genre",
                    value: g,
                    uid: currentUser?.uid ?? null,
                  }).catch(() => {});
                }}
              >
                {g}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
