import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../store/useAppStore.js";
import { sanitizePosterUrl } from "../lib/utils.js";
import { logEvent } from "../lib/axiom-logger.js";
import type { RecommendationItem, WatchlistItem } from "../types/index.js";
import {
  useRecommendations,
  useDismissedRecommendations,
  useDismissRecommendation,
} from "../hooks/useRecommendations.js";

const RECS_STRIP_MAX = 4;

/** Build a WatchlistItem-compatible object so the existing TrailerModal can display rec metadata. */
function recToWatchlistItem(item: RecommendationItem): WatchlistItem {
  return {
    title: item.title,
    year: item.year,
    type: item.type,
    thumb: item.thumb,
    youtubeId: item.youtubeId,
    imdbId: item.imdbId,
    tmdbId: item.tmdbId,
    tmdbMedia: item.mediaType,
    ...(item.registryId != null ? { registryId: item.registryId } : {}),
    services: item.services,
    servicesByRegion: null,
    genre: item.genres.join(", "),
    source: "recommendation",
  };
}

interface RecCardProps {
  item: RecommendationItem;
  layout: "strip" | "grid";
  onDismiss: (tmdbId: number) => void;
  onOpenTrailer: (item: RecommendationItem) => void;
}

function RecCard({ item, layout, onDismiss, onOpenTrailer }: RecCardProps) {
  const [out, setOut] = useState(false);
  const thumbSrc = sanitizePosterUrl(item.thumb);
  const typeBadge = item.type === "movie" ? "MOVIE" : "SERIES";

  const handleDismiss = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      setOut(true);
      window.setTimeout(() => {
        onDismiss(item.tmdbId);
      }, 420);
    },
    [item.tmdbId, onDismiss]
  );

  const handleClick = useCallback(() => {
    if (item.youtubeId) onOpenTrailer(item);
  }, [item, onOpenTrailer]);

  return (
    <div
      className={`up-next-card recs-card${out ? " up-next-card--out" : ""}${layout === "grid" ? " up-next-card--grid" : ""}`}
      role="listitem"
    >
      <button
        type="button"
        className="up-next-card-hit"
        onClick={handleClick}
        aria-label={
          item.youtubeId
            ? `Watch trailer for ${item.title}`
            : item.title
        }
        style={!item.youtubeId ? { cursor: "default" } : undefined}
      >
        <div className="up-next-card-poster recs-card-poster">
          {thumbSrc ? (
            <img src={thumbSrc} alt="" loading="lazy" />
          ) : (
            <span className="up-next-card-poster-ph" aria-hidden />
          )}
          {item.youtubeId ? (
            <span className="recs-play-overlay" aria-hidden>
              <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                <path d="M8 5v14l11-7z" />
              </svg>
            </span>
          ) : null}
        </div>
        <div className="up-next-card-copy recs-card-copy">
          <div className="up-next-card-title">
            {item.title}
            {item.year ? <span className="recs-card-year"> ({item.year})</span> : null}
          </div>
          <div className="recs-card-badge">{typeBadge}</div>
          {item.explanation ? (
            <div className="recs-card-explanation">{item.explanation}</div>
          ) : null}
        </div>
      </button>
      <div className="up-next-card-actions">
        <button
          type="button"
          className="up-next-card-icon-btn up-next-card-dismiss-btn"
          aria-label="Not interested"
          title="Not interested"
          onClick={handleDismiss}
        >
          ×
        </button>
      </div>
    </div>
  );
}

function RecsSkeletonStrip() {
  return (
    <div className="up-next-section">
      <div className="upcoming-alerts-panel">
        <h2 className="up-next-section-label">Recommended for you</h2>
        <div className="up-next-views">
          <div
            className="up-next-skeleton-strip"
            role="status"
            aria-busy="true"
            aria-label="Loading recommendations"
          >
            {[0, 1, 2].map((i) => (
              <div key={i} className="up-next-card recs-card up-next-card--skeleton" aria-hidden>
                <div className="up-next-card-poster skeleton-shimmer" />
                <div className="up-next-card-copy">
                  <span className="skeleton-up-next-line skeleton-up-next-line--title skeleton-shimmer" />
                  <span className="skeleton-up-next-line skeleton-up-next-line--detail skeleton-shimmer" />
                  <span className="skeleton-up-next-line skeleton-up-next-line--date skeleton-shimmer" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export interface RecommendationsSectionProps {
  movies: WatchlistItem[];
  watchlistPending?: boolean;
}

export function RecommendationsSection({
  movies,
  watchlistPending = false,
}: RecommendationsSectionProps) {
  const currentUser = useAppStore((s) => s.currentUser);
  const setCurrentModalMovie = useAppStore((s) => s.setCurrentModalMovie);
  const currentListMode = useAppStore((s) => s.currentListMode);
  const uid = currentUser?.uid;

  const isSharedList =
    typeof currentListMode === "object" && currentListMode.type === "shared";
  const sectionLabel = isSharedList ? "Recommended for this list" : "Recommended for you";
  const headingId = "recs-heading";

  const recsQ = useRecommendations(uid, currentListMode);
  const dismissedQ = useDismissedRecommendations(uid);
  const dismiss = useDismissRecommendation(uid);

  const [stripExpanded, setStripExpanded] = useState(false);
  const stripRef = useRef<HTMLDivElement>(null);
  const [showEndFade, setShowEndFade] = useState(false);

  // Build set of tmdbIds already on the list (skip those in recommendations)
  const listTmdbIds = useMemo(() => {
    const ids = new Set<number>();
    for (const m of movies) {
      if (m.tmdbId != null) ids.add(m.tmdbId);
    }
    return ids;
  }, [movies]);

  const dismissedIds = dismissedQ.data ?? new Set<number>();

  const visibleItems = useMemo(() => {
    if (!recsQ.data?.items) return [];
    return recsQ.data.items.filter(
      (item) => !dismissedIds.has(item.tmdbId) && !listTmdbIds.has(item.tmdbId)
    );
  }, [recsQ.data?.items, dismissedIds, listTmdbIds]);

  // Collapse strip when items drop to ≤ max
  if (visibleItems.length <= RECS_STRIP_MAX && stripExpanded) {
    setStripExpanded(false);
  }

  const updateStripFade = useCallback(() => {
    const el = stripRef.current;
    if (!el) {
      setShowEndFade(false);
      return;
    }
    const needsScroll = el.scrollWidth > el.clientWidth + 1;
    const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 2;
    setShowEndFade(needsScroll && !atEnd);
  }, []);

  useLayoutEffect(() => {
    if (stripExpanded) {
      setShowEndFade(false);
      return;
    }
    updateStripFade();
    const el = stripRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => updateStripFade());
    ro.observe(el);
    return () => ro.disconnect();
  }, [visibleItems.length, stripExpanded, updateStripFade]);

  const openTrailer = useCallback(
    (item: RecommendationItem) => {
      void logEvent({
        type: "user.action",
        action: "trailer.open",
        tmdbId: item.tmdbId,
        title: item.title,
        uid: uid ?? null,
        source: "recommendations",
      } as Parameters<typeof logEvent>[0]).catch(() => {});
      setCurrentModalMovie(recToWatchlistItem(item));
    },
    [uid, setCurrentModalMovie]
  );

  if (!uid) return null;
  if (recsQ.isError) return null;

  const showSkeleton = watchlistPending || (recsQ.isPending && !recsQ.data);
  if (showSkeleton) return <RecsSkeletonStrip />;

  if (!recsQ.isSuccess) return null;
  if (visibleItems.length === 0) return null;

  const overflow = visibleItems.length > RECS_STRIP_MAX;
  const stripItems = overflow ? visibleItems.slice(0, RECS_STRIP_MAX) : visibleItems;
  const restCount = overflow ? visibleItems.length - RECS_STRIP_MAX : 0;

  return (
    <div className="up-next-section">
      <div className="upcoming-alerts-panel">
        <h2 id={headingId} className="up-next-section-label">
          {sectionLabel}
        </h2>
        <div className="up-next-views">
          {stripExpanded ? (
            <div key="recs-expanded" className="up-next-expanded-wrap up-next-view-animate">
              <div
                className="up-next-expanded-grid"
                role="list"
                aria-labelledby={headingId}
              >
                {visibleItems.map((item) => (
                  <RecCard
                    key={item.tmdbId}
                    item={item}
                    layout="grid"
                    onDismiss={dismiss}
                    onOpenTrailer={openTrailer}
                  />
                ))}
              </div>
              <div className="up-next-less-row">
                <button
                  type="button"
                  className="up-next-less-btn"
                  onClick={() => setStripExpanded(false)}
                >
                  Show less ↑
                </button>
              </div>
            </div>
          ) : (
            <div key="recs-collapsed" className="up-next-collapsed-wrap up-next-view-animate">
              {overflow ? (
                <div className="up-next-strip-outer">
                  <div className="up-next-strip-row">
                    <div
                      className={`up-next-strip-scroll-zone${showEndFade ? " up-next-strip-scroll-zone--fade" : ""}`}
                    >
                      <div
                        ref={stripRef}
                        className="up-next-strip"
                        role="list"
                        aria-labelledby={headingId}
                        onScroll={updateStripFade}
                      >
                        {stripItems.map((item) => (
                          <RecCard
                            key={item.tmdbId}
                            item={item}
                            layout="strip"
                            onDismiss={dismiss}
                            onOpenTrailer={openTrailer}
                          />
                        ))}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="up-next-more-card"
                      onClick={() => setStripExpanded(true)}
                    >
                      <span className="up-next-more-card-label">and {restCount} more →</span>
                    </button>
                  </div>
                </div>
              ) : (
                <div
                  className={`up-next-strip-outer${showEndFade ? " up-next-strip-outer--fade" : ""}`}
                >
                  <div
                    ref={stripRef}
                    className="up-next-strip"
                    role="list"
                    aria-labelledby={headingId}
                    onScroll={updateStripFade}
                  >
                    {stripItems.map((item) => (
                      <RecCard
                        key={item.tmdbId}
                        item={item}
                        layout="strip"
                        onDismiss={dismiss}
                        onOpenTrailer={openTrailer}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
