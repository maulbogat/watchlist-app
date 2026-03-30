import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAppStore, STATUS_LABELS } from "../store/useAppStore.js";
import { persistFilterPreferences } from "../lib/storage.js";
import { getUniqueAddersFromMovies, getUniqueGenresFromMovies } from "../lib/watchlistFilters.js";
import { logEvent } from "../lib/axiom-logger.js";
import type { FilterType, SortType, WatchlistItem } from "../types/index.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/shadcn-utils";

const watchlistSelectContentClass =
  "watchlist-filter-select-content custom-dropdown-content lists-modal-select-popover--no-check z-[1300] min-w-[var(--radix-select-trigger-width)] border border-[var(--border)] bg-[var(--surface2)] text-[var(--text)] shadow-[0_12px_40px_rgba(0,0,0,0.55)] ring-1 ring-white/[0.08]";

interface WatchlistToolbarProps {
  allMovies: WatchlistItem[];
  visibleCount: number;
  /** Watchlist titles query in flight — replaces title count with a neutral pill. */
  watchlistLoading?: boolean;
}

export function WatchlistToolbar({
  allMovies,
  visibleCount,
  watchlistLoading = false,
}: WatchlistToolbarProps) {
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
  const currentAddedByUid = useAppStore((s) => s.currentAddedByUid);
  const setCurrentAddedByUid = useAppStore((s) => s.setCurrentAddedByUid);
  const currentListMode = useAppStore((s) => s.currentListMode);

  const isSharedList =
    currentListMode && typeof currentListMode === "object" && currentListMode.type === "shared";

  const genres = getUniqueGenresFromMovies(allMovies);
  const genresSorted = useMemo(
    () => [...genres].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })),
    [genres]
  );
  const adders = isSharedList ? getUniqueAddersFromMovies(allMovies, currentUser?.uid ?? null) : [];

  const [genrePopoverOpen, setGenrePopoverOpen] = useState(false);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const [searchFocused, setSearchFocused] = useState(false);

  const sentinelRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [toolbarSticky, setToolbarSticky] = useState(false);
  const toolbarStickyRef = useRef(toolbarSticky);
  toolbarStickyRef.current = toolbarSticky;
  const [toolbarFlowHeight, setToolbarFlowHeight] = useState(0);

  const readToolbarBlockHeight = useCallback(() => {
    const el = toolbarRef.current;
    const sen = sentinelRef.current;
    const shell = shellRef.current;
    if (!el) return 0;
    const sticky = toolbarStickyRef.current;
    const style = getComputedStyle(el);
    const rootFontPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    let tail: number;
    if (sticky) {
      const v = style.getPropertyValue("--toolbar-flow-tail-gap").trim();
      tail = v.endsWith("rem") ? (parseFloat(v) || 0) * rootFontPx : parseFloat(v) || 0;
    } else {
      tail = parseFloat(style.marginBottom) || 0;
    }
    let shellPadY = 0;
    if (sticky && shell) {
      const sh = getComputedStyle(shell);
      shellPadY = (parseFloat(sh.paddingTop) || 0) + (parseFloat(sh.paddingBottom) || 0);
    }
    return (sen?.offsetHeight ?? 1) + el.offsetHeight + shellPadY + tail;
  }, []);

  useLayoutEffect(() => {
    const el = toolbarRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      setToolbarFlowHeight(readToolbarBlockHeight());
    });
    ro.observe(el);
    setToolbarFlowHeight(readToolbarBlockHeight());
    return () => ro.disconnect();
  }, [adders.length, genres.length, readToolbarBlockHeight, toolbarSticky]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        const stick = !entry.isIntersecting;
        setToolbarSticky(stick);
      },
      { root: null, rootMargin: "0px", threshold: 0 }
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [readToolbarBlockHeight]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target;
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      searchInputRef.current?.focus();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  function persistFilters() {
    persistFilterPreferences(currentUser, {
      currentFilter: useAppStore.getState().currentFilter,
      currentGenre: useAppStore.getState().currentGenre,
      currentStatus: useAppStore.getState().currentStatus,
      currentSort: useAppStore.getState().currentSort,
      currentSearch: useAppStore.getState().currentSearch,
      currentAddedByUid: useAppStore.getState().currentAddedByUid,
    });
  }

  function applyGenre(next: string) {
    setCurrentGenre(next);
    persistFilters();
    setGenrePopoverOpen(false);
    void logEvent({
      type: "user.action",
      action: "filter.change",
      filterType: "genre",
      value: next || "all",
      uid: currentUser?.uid ?? null,
    }).catch(() => {});
  }

  const spacerH = Math.max(toolbarFlowHeight, 1);

  const showSecondaryRow = genres.length > 0 || adders.length > 1;

  return (
    <>
      <div ref={sentinelRef} className="watchlist-toolbar-sentinel" aria-hidden="true" />
      {toolbarSticky ? (
        <div
          className="watchlist-toolbar-scroll-spacer"
          style={{ height: spacerH }}
          aria-hidden="true"
        />
      ) : null}
      <div
        ref={shellRef}
        className={
          toolbarSticky
            ? "watchlist-toolbar-sticky-shell watchlist-toolbar-sticky-shell--stuck"
            : "watchlist-toolbar-sticky-shell"
        }
      >
        <div className="watchlist-toolbar-sticky-inner">
          <div
            ref={toolbarRef}
            id="content-filters"
            className={`content-filters${toolbarSticky ? " content-filters--toolbar-sticky toolbar--sticky" : ""}`}
          >
            <div className="watchlist-toolbar-primary-row">
              <div className="tab-group-wrap">
                <div className="tab-group" role="tablist" aria-label="Watch status">
                  {[
                    { id: "tab-all", status: "all", label: "All" },
                    { id: "tab-to-watch", status: "to-watch", label: STATUS_LABELS["to-watch"] },
                    { id: "tab-watched", status: "watched", label: STATUS_LABELS.watched },
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
                <span
                  className={`filter-count${watchlistLoading ? " filter-count--loading" : ""}`}
                  id="filter-count"
                  aria-live={watchlistLoading ? "off" : "polite"}
                  aria-busy={watchlistLoading}
                >
                  {watchlistLoading ? (
                    <span className="filter-count-pill-skeleton skeleton-shimmer" />
                  ) : typeof visibleCount === "number" ? (
                    `${visibleCount} title${visibleCount === 1 ? "" : "s"}`
                  ) : (
                    ""
                  )}
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
                <Select
                  value={currentSort}
                  onValueChange={(nextSort) => {
                    setCurrentSort(nextSort as SortType);
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
                  <SelectTrigger
                    id="sort-select"
                    className={`custom-dropdown-trigger watchlist-toolbar-select-trigger focus-visible:ring-0 shadow-none${currentSort !== "title-asc" ? " watchlist-filter-trigger--active" : ""}`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent
                    className={watchlistSelectContentClass}
                    position="popper"
                    side="bottom"
                    align="start"
                    sideOffset={8}
                  >
                    <SelectItem value="title-asc" className="custom-dropdown-item">
                      Title (A-Z)
                    </SelectItem>
                    <SelectItem value="release-desc" className="custom-dropdown-item">
                      Release Date (New-Old)
                    </SelectItem>
                    <SelectItem value="added-desc" className="custom-dropdown-item">
                      Date Added (New → Old)
                    </SelectItem>
                    <SelectItem value="added-asc" className="custom-dropdown-item">
                      Date Added (Old → New)
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="search-wrap">
                <label htmlFor="title-search">Search</label>
                <input
                  ref={searchInputRef}
                  id="title-search"
                  type="text"
                  className="search-input"
                  placeholder={searchFocused ? "Search titles" : "Search titles · /"}
                  value={currentSearch}
                  onFocus={() => setSearchFocused(true)}
                  onChange={(e) => {
                    setCurrentSearch(e.target.value);
                    persistFilters();
                  }}
                  onBlur={() => {
                    setSearchFocused(false);
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
            </div>

            {showSecondaryRow ? (
              <div className="watchlist-toolbar-secondary-row">
                {genres.length ? (
                  <div id="genre-filter-wrap" className="watchlist-toolbar-genre-wrap">
                    <Popover open={genrePopoverOpen} onOpenChange={setGenrePopoverOpen}>
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          id="genre-filter-trigger"
                          className={cn(
                            "custom-dropdown-trigger watchlist-toolbar-select-trigger watchlist-genre-popover-trigger focus-visible:ring-0 shadow-none",
                            currentGenre ? "watchlist-genre-popover-trigger--active" : ""
                          )}
                          aria-haspopup="listbox"
                          aria-expanded={genrePopoverOpen}
                          aria-controls="genre-filter-listbox"
                        >
                          <span className="watchlist-genre-popover-trigger-label">
                            {currentGenre || "All Genres"}
                          </span>
                        </button>
                      </PopoverTrigger>
                      <PopoverContent
                        id="genre-filter-popover"
                        align="start"
                        side="bottom"
                        sideOffset={8}
                        avoidCollisions={true}
                        className="watchlist-genre-popover-content"
                      >
                        <div
                          id="genre-filter-listbox"
                          role="listbox"
                          aria-label="Genre"
                          className="watchlist-genre-popover-list"
                        >
                          <button
                            type="button"
                            role="option"
                            aria-selected={!currentGenre}
                            className={cn(
                              "watchlist-genre-option",
                              !currentGenre ? "watchlist-genre-option--active" : ""
                            )}
                            onClick={() => applyGenre("")}
                          >
                            All Genres
                          </button>
                          {genresSorted.map((g) => {
                            const active = currentGenre === g;
                            return (
                              <button
                                key={g}
                                type="button"
                                role="option"
                                aria-selected={active}
                                className={cn(
                                  "watchlist-genre-option",
                                  active ? "watchlist-genre-option--active" : ""
                                )}
                                onClick={() => applyGenre(g)}
                              >
                                {g}
                              </button>
                            );
                          })}
                        </div>
                      </PopoverContent>
                    </Popover>
                  </div>
                ) : null}
                {adders.length > 1 ? (
                  <div
                    id="added-by-filter-wrap"
                    className={`added-by-filter-wrap${currentAddedByUid ? " added-by-filter-wrap--active" : ""}`}
                    role="group"
                    aria-label="Filter by who added the title"
                  >
                    <span className="tertiary-filter-label">Added by</span>
                    <div className="segmented-control" role="radiogroup" aria-label="Added by">
                      <button
                        type="button"
                        className={`segmented-control-btn${!currentAddedByUid ? " active" : ""}`}
                        data-added-by=""
                        aria-pressed={!currentAddedByUid}
                        onClick={() => {
                          setCurrentAddedByUid("");
                          persistFilters();
                          void logEvent({
                            type: "user.action",
                            action: "filter.change",
                            filterType: "addedBy",
                            value: "all",
                            uid: currentUser?.uid ?? null,
                          }).catch(() => {});
                        }}
                      >
                        All
                      </button>
                      {adders.map(({ uid, label }) => {
                        const active = currentAddedByUid === uid;
                        return (
                          <button
                            key={uid}
                            type="button"
                            className={`segmented-control-btn${active ? " active" : ""}`}
                            data-added-by={uid}
                            aria-pressed={active}
                            onClick={() => {
                              setCurrentAddedByUid(uid);
                              persistFilters();
                              void logEvent({
                                type: "user.action",
                                action: "filter.change",
                                filterType: "addedBy",
                                value: uid,
                                uid: currentUser?.uid ?? null,
                              }).catch(() => {});
                            }}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}
