import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ListMode, StatusKey, WatchlistItem } from "../types/index.js";
import { useAppStore } from "../store/useAppStore.js";
import {
  hasPlayableTrailerYoutubeId,
  renderServiceChips,
  servicesForMovie,
} from "../lib/movieDisplay.js";
import {
  usePersonalLists,
  useSharedLists,
  useFavorites,
  useWatchlistMovies,
} from "../hooks/useWatchlist.js";
import {
  useAddTitleToList,
  useRemoveTitleFromList,
  useSetTitleStatus,
  useToggleFavorite,
} from "../hooks/useMutations.js";
import { useAddRecommendation } from "../hooks/useRecommendations.js";
import { displayListName, errorMessage } from "../lib/utils.js";
import { logEvent } from "../lib/axiom-logger.js";
import { getPersonalListMovies, listKey } from "../firebase.js";
import { toast } from "sonner";

const MODAL_LANG_NAMES: Record<string, string> = {
  he: "Hebrew",
  fr: "French",
  es: "Spanish",
  de: "German",
  ko: "Korean",
  ja: "Japanese",
  it: "Italian",
  ar: "Arabic",
};

function modalOriginalLanguageLabel(code: string | null | undefined): string | null {
  const raw = typeof code === "string" ? code.trim().toLowerCase() : "";
  if (!raw || raw === "en") return null;
  const two = raw.slice(0, 2);
  return MODAL_LANG_NAMES[two] ?? two.toUpperCase();
}

interface ListRowInfo {
  id: string;
  name: string;
  type: "personal" | "shared";
}

function listInfoToMode(info: ListRowInfo): ListMode {
  if (info.type === "shared") return { type: "shared", listId: info.id, name: info.name };
  if (info.id === "personal") return "personal";
  return { type: "personal", listId: info.id };
}

interface PerListRowProps {
  listInfo: ListRowInfo;
  movie: WatchlistItem;
  uid: string;
}

function PerListRow({ listInfo, movie, uid }: PerListRowProps) {
  const listMode = listInfoToMode(listInfo);
  const favorites = useFavorites(uid, listMode);
  const setTitleStatusMutation = useSetTitleStatus();
  const removeTitleFromListMutation = useRemoveTitleFromList();
  const toggleFavoriteMutation = useToggleFavorite();

  // Subscribe to the list's cache — reactive, serves from cache if already loaded
  const { data: listMovies = [] } = useWatchlistMovies(uid, listMode);

  const movieKey = listKey(movie);
  const cachedItem = listMovies.find((x) => listKey(x) === movieKey);
  const status: StatusKey = cachedItem?.status ?? movie.status ?? "to-watch";
  const isLiked = favorites.has(movieKey);

  const [confirmRemove, setConfirmRemove] = useState(false);
  const confirmTimer = useRef<number | null>(null);

  function startConfirmRemove(e: ReactMouseEvent) {
    e.stopPropagation();
    if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
    setConfirmRemove(true);
    confirmTimer.current = window.setTimeout(() => setConfirmRemove(false), 3000);
  }

  function cancelConfirmRemove(e: ReactMouseEvent) {
    e.stopPropagation();
    if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
    setConfirmRemove(false);
  }

  useEffect(() => {
    return () => {
      if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
    };
  }, []);

  async function onStatusChange(st: StatusKey) {
    try {
      await setTitleStatusMutation.mutateAsync({ uid, listMode, key: movieKey, status: st });
      void logEvent({
        type: "user.action",
        action: "status.change",
        tmdbId: movie.tmdbId ?? null,
        status: st,
        uid,
      }).catch(() => {});
    } catch (err: unknown) {
      toast.error(errorMessage(err) || "Failed to update status.");
    }
  }

  async function onLikeToggle(e: ReactMouseEvent) {
    e.stopPropagation();
    try {
      await toggleFavoriteMutation.mutateAsync({
        uid,
        listMode,
        registryId: movieKey,
        isFavorite: !isLiked,
      });
    } catch (err: unknown) {
      toast.error(errorMessage(err) || "Failed to update.");
    }
  }

  async function onConfirmRemove(e: ReactMouseEvent) {
    e.stopPropagation();
    if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
    try {
      await removeTitleFromListMutation.mutateAsync({
        uid,
        listId: listInfo.id,
        key: movieKey,
        type: listInfo.type,
      });
    } catch (err: unknown) {
      toast.error(errorMessage(err) || "Failed to remove.");
      setConfirmRemove(false);
    }
  }

  return (
    <div className="modal-list-row">
      <span className="modal-list-row-name">{listInfo.name}</span>
      {confirmRemove ? (
        <span className="modal-list-row-confirm">
          <span className="modal-list-row-confirm-label">Remove?</span>
          <button
            type="button"
            className="modal-list-row-confirm-yes"
            onClick={(e) => { void onConfirmRemove(e); }}
          >
            Yes
          </button>
          <button
            type="button"
            className="modal-list-row-confirm-no"
            onClick={cancelConfirmRemove}
          >
            No
          </button>
        </span>
      ) : (
        <>
          <select
            className="modal-list-row-status"
            value={status}
            aria-label={`Status for ${listInfo.name}`}
            onChange={(e) => { void onStatusChange(e.target.value as StatusKey); }}
          >
            <option value="to-watch">To watch</option>
            <option value="watched">Watched</option>
          </select>
          <button
            type="button"
            className={`modal-list-row-like${isLiked ? " modal-list-row-like--active" : ""}`}
            aria-label={isLiked ? `Unlike on ${listInfo.name}` : `Like on ${listInfo.name}`}
            onClick={(e) => { void onLikeToggle(e); }}
          >
            {isLiked ? "♥" : "♡"}
          </button>
          <button
            type="button"
            className="modal-list-row-remove"
            aria-label={`Remove from ${listInfo.name}`}
            onClick={startConfirmRemove}
          >
            ✕
          </button>
        </>
      )}
    </div>
  );
}

export function TrailerModal() {
  const queryClient = useQueryClient();
  const currentUser = useAppStore((s) => s.currentUser);
  const movie = useAppStore((s) => s.currentModalMovie);
  const setCurrentModalMovie = useAppStore((s) => s.setCurrentModalMovie);
  const userCountryCode = useAppStore((s) => s.userCountryCode);
  const addTitleMutation = useAddTitleToList();
  const addRecommendationMutation = useAddRecommendation(currentUser?.uid);

  const personalQ = usePersonalLists(currentUser?.uid, { enabled: Boolean(currentUser?.uid) });
  const sharedQ = useSharedLists(currentUser?.uid, { enabled: Boolean(currentUser?.uid) });
  /** Stable when `data` is undefined — a bare `?? []` creates a new array every render and retriggers effects. */
  const personalLists = useMemo(() => personalQ.data ?? [], [personalQ.data]);
  const sharedLists = useMemo(() => sharedQ.data ?? [], [sharedQ.data]);

  /** Close dropdowns when switching titles, not when the same row gets a new object (e.g. status). */
  const movieStableKey = movie ? listKey(movie) : null;

  const [addListOpen, setAddListOpen] = useState(false);
  const uid = currentUser?.uid;
  const listsFetched = personalQ.isFetched && sharedQ.isFetched;

  /** Stable key when list *membership* metadata changes — avoid churn from personalLists count optimistic updates. */
  const listStructureKey = useMemo(() => {
    const p = personalLists
      .map((l) => l.id)
      .slice()
      .sort()
      .join("\0");
    const s = sharedLists
      .map((l) => l.id)
      .slice()
      .sort()
      .join("\0");
    return `${p}|${s}`;
  }, [personalLists, sharedLists]);

  const { data: containingLists = new Set<string>(), isLoading: containingLoading } = useQuery({
    queryKey: ["listsContaining", movieStableKey, uid, listStructureKey],
    queryFn: async () => {
      if (!movie || !uid) return new Set<string>();
      const key = listKey(movie);
      const containing = new Set<string>();
      const personalResults = await Promise.all(
        personalLists.map(async (l) => {
          const listId = l.id;
          const cacheKey =
            listId === "personal"
              ? ["watchlistMovies", uid, "personal"]
              : ["watchlistMovies", uid, "personal", listId];
          let listMovies = queryClient.getQueryData<WatchlistItem[]>(cacheKey);
          if (!listMovies) {
            try {
              listMovies = await getPersonalListMovies(uid, listId);
            } catch {
              listMovies = [];
            }
          }
          return { listId, inList: listMovies.some((x) => listKey(x) === key) };
        })
      );
      for (const { listId, inList } of personalResults) {
        if (inList) containing.add(listId);
      }
      for (const l of sharedLists) {
        const sharedCacheKey = ["watchlistMovies", uid, "shared", l.id];
        const cachedShared = queryClient.getQueryData<WatchlistItem[]>(sharedCacheKey);
        if (cachedShared) {
          if (cachedShared.some((x) => listKey(x) === key)) containing.add(l.id);
        } else {
          const items = Array.isArray(l.items) ? l.items : [];
          if (items.some((row) => listKey(row) === key)) containing.add(l.id);
        }
      }
      return containing;
    },
    enabled: Boolean(movie && uid),
    staleTime: 60_000,
  });

  useEffect(() => {
    setAddListOpen(false);
  }, [movieStableKey]);

  useEffect(() => {
    if (!movie) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setAddListOpen(false);
        setCurrentModalMovie(null);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [movie, setCurrentModalMovie]);

  useEffect(() => {
    if (!addListOpen) return;
    function onDocClick(ev: MouseEvent) {
      const footer = document.getElementById("modal-footer");
      const t = ev.target;
      if (footer && t instanceof Node && !footer.contains(t)) {
        setAddListOpen(false);
      }
    }
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [addListOpen]);

  if (!movie) return null;

  const m = movie;

  function close() {
    setAddListOpen(false);
    setCurrentModalMovie(null);
  }

  const imdbUrl = m.imdbId ? `https://www.imdb.com/title/${m.imdbId}/` : null;
  const isRec = m.source === "recommendation";

  // Build per-list row data: lists this title IS on and lists it is NOT on
  const allListInfos: ListRowInfo[] = [
    ...personalLists.map((l) => ({
      id: l.id,
      name: displayListName(l.name),
      type: "personal" as const,
    })),
    ...sharedLists.map((l) => ({
      id: l.id,
      name: displayListName(l.name),
      type: "shared" as const,
    })),
  ];
  const onLists = allListInfos.filter((l) => containingLists.has(l.id));
  const notOnLists = allListInfos.filter((l) => !containingLists.has(l.id));

  async function onAddToList(listInfo: ListRowInfo) {
    if (!uid) return;
    const targetMode = listInfoToMode(listInfo);
    try {
      await addTitleMutation.mutateAsync({
        uid,
        listMode: targetMode,
        item: { ...m, status: "to-watch" },
      });
    } catch (err: unknown) {
      toast.error(errorMessage(err) || "Failed to add to list.");
    }
    setAddListOpen(false);
  }

  async function onAddRecommendationToList(listInfo: ListRowInfo) {
    if (!uid) return;
    const targetMode = listInfoToMode(listInfo);
    try {
      const result = await addRecommendationMutation.mutateAsync({ item: m, listMode: targetMode });
      toast.success(`Added "${result.title}" to list`);
      // Invalidate so the new row appears in containingLists
      if (movieStableKey) {
        void queryClient.invalidateQueries({
          predicate: (q) => {
            const k = q.queryKey;
            return (
              Array.isArray(k) &&
              k[0] === "listsContaining" &&
              k[1] === movieStableKey &&
              k[2] === uid
            );
          },
        });
      }
    } catch (err: unknown) {
      toast.error(errorMessage(err) || "Failed to add to list.");
    }
    setAddListOpen(false);
  }

  const metaCore = [m.year || "", m.genre || ""].filter(Boolean).join(" ");
  const langLabel = modalOriginalLanguageLabel(m.originalLanguage);
  const metaParts =
    langLabel && metaCore
      ? `${metaCore} · ${langLabel}`
      : langLabel && !metaCore
        ? langLabel
        : metaCore;
  const serviceChips = renderServiceChips(servicesForMovie(m, userCountryCode));
  const servicePart = serviceChips ? (
    <span
      dangerouslySetInnerHTML={{ __html: ` <span style="opacity:0.4">·</span> ${serviceChips}` }}
    />
  ) : null;

  const hasTrailer = hasPlayableTrailerYoutubeId(m);

  return (
    <div
      className="modal-bg open"
      id="modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-header">
          <span
            className="modal-title"
            id="modal-title"
            dir={/[\u0590-\u05FF]/.test(m.title) ? "rtl" : undefined}
          >
            {m.title}
          </span>
          <button
            type="button"
            className="modal-close"
            id="modal-close"
            aria-label="Close"
            onClick={close}
          >
            &#x2715;
          </button>
        </div>
        <div className="video-wrap">
          {hasTrailer && m.youtubeId ? (
            <iframe
              id="modal-iframe"
              title="Trailer"
              allowFullScreen
              allow="autoplay; encrypted-media; picture-in-picture"
              referrerPolicy="strict-origin-when-cross-origin"
              src={`https://www.youtube.com/embed/${encodeURIComponent(m.youtubeId)}?rel=0&modestbranding=1&playsinline=1`}
            />
          ) : (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: "1.25rem",
                padding: "1.5rem",
                textAlign: "center",
                background: "#0d0d10",
              }}
            >
              <p
                style={{
                  fontFamily: "var(--font-title)",
                  fontSize: "1.25rem",
                  letterSpacing: "0.06em",
                  color: "var(--text)",
                  margin: 0,
                }}
              >
                No trailer available
              </p>
              <p
                style={{
                  fontSize: "0.88rem",
                  color: "var(--muted)",
                  margin: 0,
                  maxWidth: "22rem",
                  lineHeight: 1.45,
                }}
              >
                There is no YouTube trailer on TMDB for this title, or it has not been loaded yet.
              </p>
              {imdbUrl ? (
                <a
                  href={imdbUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="modal-action-btn modal-youtube-link"
                >
                  View on IMDb &#x2197;
                </a>
              ) : null}
            </div>
          )}
        </div>
        <div className="modal-footer" id="modal-footer">
          <div className="modal-footer-meta">
            {metaParts}
            {servicePart}
          </div>
          <div className="modal-footer-actions">
            {/* Per-list rows section */}
            {uid ? (
              <div className="modal-lists-section">
                {containingLoading && !listsFetched ? (
                  <span className="modal-add-to-list-loading">Loading…</span>
                ) : null}
                {!containingLoading || listsFetched ? (
                  <>
                    {onLists.map((listInfo) => (
                      <PerListRow
                        key={`${listInfo.type}-${listInfo.id}`}
                        listInfo={listInfo}
                        movie={m}
                        uid={uid}
                      />
                    ))}
                    {notOnLists.length > 0 ? (
                      <div className="modal-action-dropdown" data-dropdown="add-to-list">
                        <button
                          type="button"
                          className="modal-add-to-list-btn"
                          aria-haspopup="true"
                          aria-expanded={addListOpen}
                          onClick={(e) => {
                            e.stopPropagation();
                            setAddListOpen((o) => !o);
                          }}
                        >
                          + Add to list
                        </button>
                        <div
                          className={`modal-action-dropdown-panel modal-add-to-list-panel${addListOpen ? " open" : ""}`}
                          role="menu"
                        >
                          {notOnLists.map((listInfo) => (
                            <button
                              key={`${listInfo.type}-${listInfo.id}`}
                              type="button"
                              className="modal-action-dropdown-item"
                              role="menuitem"
                              disabled={
                                addTitleMutation.isPending ||
                                addRecommendationMutation.isPending
                              }
                              onClick={(e) => {
                                e.stopPropagation();
                                void (isRec
                                  ? onAddRecommendationToList(listInfo)
                                  : onAddToList(listInfo));
                              }}
                            >
                              {listInfo.name}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : null}

            {hasTrailer && m.youtubeId ? (
              <a
                href={`https://www.youtube.com/watch?v=${encodeURIComponent(m.youtubeId)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="modal-action-btn modal-youtube-link"
              >
                Watch on YouTube &#x2197;
              </a>
            ) : null}
            {imdbUrl ? (
              <a
                href={imdbUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="modal-action-btn modal-youtube-link"
              >
                Open on IMDb &#x2197;
              </a>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
