import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { UpcomingAlert, WatchlistItem } from "../types/index.js";
import { auth, fetchUpcomingAlertsForItems, listKey } from "../firebase.js";
import { getStatusData, updateDismissals } from "../data/user.js";
import {
  clearUpcomingAlertsCache,
  readUpcomingAlertsCache,
  writeUpcomingAlertsCache,
} from "../lib/storage.js";
import { useAppStore } from "../store/useAppStore.js";
import { UPCOMING_ADD_CAL_ICON_SVG } from "../store/watchlistConstants.js";
import {
  buildUpcomingIcsDocument,
  compactUpcomingDetail,
  downloadUpcomingIcs,
  formatUpcomingAirLabel,
  getUpcomingAirDateYmd,
  safeIcsDownloadFilename,
  sanitizePosterUrl,
  upcomingAlertHasRealAirDate,
} from "../lib/utils.js";
import { logEvent } from "../lib/axiom-logger.js";

type UpcomingBarData = { active: UpcomingAlert[] };

const UP_NEXT_STRIP_MAX = 4;

function useUpcomingAlertsQuery(uid: string | undefined, movies: WatchlistItem[] | undefined) {
  const ids = useMemo(() => {
    const keys = (movies || []).map((m) => listKey(m)).filter(Boolean);
    keys.sort();
    return keys.join(",");
  }, [movies]);

  return useQuery<UpcomingBarData>({
    queryKey: ["upcomingBar", uid, ids],
    queryFn: async () => {
      if (!uid) return { active: [] };
      const data = await getStatusData(uid);
      const dismissals = data.upcomingDismissals || {};
      const cached = readUpcomingAlertsCache(uid, ids);
      const raw = cached ?? (await fetchUpcomingAlertsForItems(movies || []));
      if (!cached) writeUpcomingAlertsCache(uid, ids, raw);
      const active = raw.filter(
        (a) => a.fingerprint && !dismissals[a.fingerprint] && upcomingAlertHasRealAirDate(a)
      );
      active.sort((a, b) => {
        const ad = getUpcomingAirDateYmd(a) || "9999-12-31";
        const bd = getUpcomingAirDateYmd(b) || "9999-12-31";
        if (ad !== bd) return ad.localeCompare(bd);
        return String(a.title || "").localeCompare(String(b.title || ""));
      });
      return { active };
    },
    enabled: !!uid,
    staleTime: 2 * 60 * 60 * 1000,
  });
}

function findWatchlistMovieForAlert(
  movies: WatchlistItem[],
  a: UpcomingAlert
): WatchlistItem | null {
  const tid = a.catalogTmdbId ?? a.tmdbId;
  if (tid == null) return null;
  const n = Number(tid);
  if (Number.isNaN(n)) return null;
  const isTvAlert =
    a.media === "tv" ||
    a.type === "tv" ||
    a.alertType === "new_episode" ||
    a.alertType === "new_season";
  const isMovieAlert =
    a.media === "movie" ||
    a.type === "movie" ||
    a.alertType === "upcoming_movie" ||
    a.alertType === "sequel";
  const hit = movies.find((m) => {
    if (m.tmdbId == null || Number(m.tmdbId) !== n) return false;
    if (isTvAlert) return m.type === "show";
    if (isMovieAlert) return m.type === "movie";
    return true;
  });
  return hit ?? null;
}

interface UpNextAlertCardProps {
  a: UpcomingAlert;
  userUid: string;
  matchedMovie: WatchlistItem | null;
  layout: "strip" | "grid";
  onRequestOpen: (movie: WatchlistItem | null) => void;
}

function UpNextAlertCard({
  a,
  userUid,
  matchedMovie,
  layout,
  onRequestOpen,
}: UpNextAlertCardProps) {
  const queryClient = useQueryClient();
  const ymd = getUpcomingAirDateYmd(a);
  const dateLabel = formatUpcomingAirLabel(a);
  const fp = String(a.fingerprint);
  const title = String(a.title || "");
  const detailLine = compactUpcomingDetail(a.detail);
  const [out, setOut] = useState(false);
  const thumbSrc = matchedMovie ? sanitizePosterUrl(matchedMovie.thumb) : "";

  const dismiss = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      setOut(true);
      try {
        const dismissUid = auth.currentUser?.uid;
        if (dismissUid) await updateDismissals(dismissUid, fp);
        clearUpcomingAlertsCache(dismissUid || undefined);
      } catch (err) {
        console.warn("dismiss upcoming:", err);
      }
      window.setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["upcomingBar", userUid] });
      }, 480);
    },
    [fp, queryClient, userUid]
  );

  const downloadCal = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      if (!ymd) return;
      const doc = buildUpcomingIcsDocument({
        ymd,
        title,
        detail: String(a.detail || ""),
        uid: fp,
      });
      if (!doc) return;
      downloadUpcomingIcs(doc, safeIcsDownloadFilename(title));
    },
    [a.detail, fp, title, ymd]
  );

  return (
    <div
      className={`up-next-card${out ? " up-next-card--out" : ""}${layout === "grid" ? " up-next-card--grid" : ""}`}
      data-fp={fp}
      role="listitem"
    >
      <button
        type="button"
        className="up-next-card-hit"
        onClick={() => onRequestOpen(matchedMovie)}
      >
        <div className="up-next-card-poster" aria-hidden={!thumbSrc}>
          {thumbSrc ? (
            <img src={thumbSrc} alt="" loading="lazy" />
          ) : (
            <span className="up-next-card-poster-ph" aria-hidden />
          )}
        </div>
        <div className="up-next-card-copy">
          <div className="up-next-card-title">{title}</div>
          {detailLine ? <div className="up-next-card-detail">{detailLine}</div> : null}
          <div className="up-next-card-date">{dateLabel}</div>
        </div>
      </button>
      <div className="up-next-card-actions">
        {ymd ? (
          <button
            type="button"
            className="up-next-card-icon-btn up-next-card-cal-btn"
            aria-label="Download calendar file (.ics) for Apple Calendar, Google Calendar, Outlook…"
            title="Download calendar file (.ics) for Apple Calendar, Google Calendar, Outlook…"
            onClick={downloadCal}
            dangerouslySetInnerHTML={{ __html: UPCOMING_ADD_CAL_ICON_SVG }}
          />
        ) : null}
        <button
          type="button"
          className="up-next-card-icon-btn up-next-card-dismiss-btn"
          aria-label="Dismiss upcoming alert"
          onClick={dismiss}
        >
          ×
        </button>
      </div>
    </div>
  );
}

interface UpcomingAlertsBarProps {
  movies: WatchlistItem[];
  /** True while the watchlist titles query is pending — show strip skeletons. */
  watchlistPending?: boolean;
}

function UpNextSkeletonStrip() {
  return (
    <div
      id="upcoming-alerts-mount"
      className="up-next-section upcoming-alerts-mount upcoming-alerts-mount--visible"
    >
      <div className="upcoming-alerts-panel">
        <h2 id="up-next-heading" className="up-next-section-label">
          Up next
        </h2>
        <div className="up-next-views">
          <div
            className="up-next-skeleton-strip"
            role="status"
            aria-busy="true"
            aria-label="Loading upcoming alerts"
          >
            {[0, 1, 2].map((i) => (
              <div key={i} className="up-next-card up-next-card--skeleton" aria-hidden>
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

export function UpcomingAlertsBar({ movies, watchlistPending = false }: UpcomingAlertsBarProps) {
  const currentUser = useAppStore((s) => s.currentUser);
  const setCurrentModalMovie = useAppStore((s) => s.setCurrentModalMovie);
  const { data, isSuccess, isPending, isError } = useUpcomingAlertsQuery(currentUser?.uid, movies);
  const [stripExpanded, setStripExpanded] = useState(false);
  const stripRef = useRef<HTMLDivElement>(null);
  const [showEndFade, setShowEndFade] = useState(false);

  const active = data?.active ?? [];
  const rows = useMemo(
    () => active.map((a) => ({ a, movie: findWatchlistMovieForAlert(movies, a) })),
    [active, movies]
  );

  useEffect(() => {
    if (active.length <= UP_NEXT_STRIP_MAX) setStripExpanded(false);
  }, [active.length]);

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
  }, [rows.length, stripExpanded, updateStripFade]);

  const openFromAlert = useCallback(
    (matchedMovie: WatchlistItem | null) => {
      if (matchedMovie) {
        void logEvent({
          type: "user.action",
          action: "trailer.open",
          tmdbId: matchedMovie.tmdbId ?? null,
          title: matchedMovie.title,
          uid: currentUser?.uid ?? null,
        }).catch(() => {});
        setCurrentModalMovie(matchedMovie);
        return;
      }
      const grid = document.getElementById("grid");
      if (grid) grid.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    [currentUser?.uid, setCurrentModalMovie]
  );

  if (!currentUser?.uid) return null;
  if (isError) return null;

  const showSkeleton = watchlistPending || (isPending && !data);
  if (showSkeleton) {
    return <UpNextSkeletonStrip />;
  }

  if (!isSuccess) return null;
  if (active.length === 0) return null;

  const overflow = active.length > UP_NEXT_STRIP_MAX;
  const stripRows = overflow ? rows.slice(0, UP_NEXT_STRIP_MAX) : rows;
  const restCount = overflow ? active.length - UP_NEXT_STRIP_MAX : 0;

  return (
    <div
      id="upcoming-alerts-mount"
      className="up-next-section upcoming-alerts-mount upcoming-alerts-mount--visible"
    >
      <div className="upcoming-alerts-panel">
        <h2 id="up-next-heading" className="up-next-section-label">
          Up next
        </h2>
        <div className="up-next-views">
          {stripExpanded ? (
            <div key="up-next-expanded" className="up-next-expanded-wrap up-next-view-animate">
              <div className="up-next-expanded-grid" role="list" aria-labelledby="up-next-heading">
                {rows.map(({ a, movie }) => (
                  <UpNextAlertCard
                    key={a.fingerprint}
                    a={a}
                    userUid={currentUser.uid}
                    matchedMovie={movie}
                    layout="grid"
                    onRequestOpen={openFromAlert}
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
            <div key="up-next-collapsed" className="up-next-collapsed-wrap up-next-view-animate">
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
                        aria-labelledby="up-next-heading"
                        onScroll={updateStripFade}
                      >
                        {stripRows.map(({ a, movie }) => (
                          <UpNextAlertCard
                            key={a.fingerprint}
                            a={a}
                            userUid={currentUser.uid}
                            matchedMovie={movie}
                            layout="strip"
                            onRequestOpen={openFromAlert}
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
                    aria-labelledby="up-next-heading"
                    onScroll={updateStripFade}
                  >
                    {stripRows.map(({ a, movie }) => (
                      <UpNextAlertCard
                        key={a.fingerprint}
                        a={a}
                        userUid={currentUser.uid}
                        matchedMovie={movie}
                        layout="strip"
                        onRequestOpen={openFromAlert}
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
