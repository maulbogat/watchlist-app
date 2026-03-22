import { useEffect, useMemo, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import type { StatusKey } from "../types/index.js";
import { useAppStore, STATUS_ORDER, STATUS_LABELS, CHECK_SVG } from "../store/useAppStore.js";
import { hasPlayableTrailerYoutubeId, renderServiceChips, servicesForMovie } from "../lib/movieDisplay.js";
import { usePersonalLists, useSharedLists } from "../hooks/useWatchlist.js";
import {
  useAddTitleToList,
  useRemoveTitleFromList,
  useSetTitleStatus,
} from "../hooks/useMutations.js";
import { getCurrentListLabel, getListsContainingMovie } from "../data/lists.js";
import { displayListName, errorMessage } from "../lib/utils.js";
import { movieKey } from "../firebase.js";

export function TrailerModal() {
  const currentUser = useAppStore((s) => s.currentUser);
  const movie = useAppStore((s) => s.currentModalMovie);
  const setCurrentModalMovie = useAppStore((s) => s.setCurrentModalMovie);
  const userCountryCode = useAppStore((s) => s.userCountryCode);
  const currentListMode = useAppStore((s) => s.currentListMode);
  const setTitleStatusMutation = useSetTitleStatus();
  const addTitleMutation = useAddTitleToList();
  const removeTitleFromListMutation = useRemoveTitleFromList();

  const personalQ = usePersonalLists(currentUser?.uid, { enabled: Boolean(currentUser?.uid) });
  const sharedQ = useSharedLists(currentUser?.uid, { enabled: Boolean(currentUser?.uid) });
  /** Stable when `data` is undefined — a bare `?? []` creates a new array every render and retriggers effects. */
  const personalLists = useMemo(() => personalQ.data ?? [], [personalQ.data]);
  const sharedLists = useMemo(() => sharedQ.data ?? [], [sharedQ.data]);

  /** Close dropdowns when switching titles, not when the same row gets a new object (e.g. status). */
  const movieStableKey = movie ? movieKey(movie) : null;

  const [statusOpen, setStatusOpen] = useState(false);
  const [addListOpen, setAddListOpen] = useState(false);
  const uid = currentUser?.uid;
  const listsFetched = personalQ.isFetched && sharedQ.isFetched;
  const listActionBusy = addTitleMutation.isPending || removeTitleFromListMutation.isPending;

  const { data: containingLists = new Set<string>(), isLoading: containingLoading } = useQuery({
    queryKey: ["listsContaining", movieStableKey, uid, personalQ.dataUpdatedAt, sharedQ.dataUpdatedAt],
    queryFn: async () => {
      if (!movie || !uid) return new Set<string>();
      return getListsContainingMovie(movie, personalLists, sharedLists, uid);
    },
    enabled: Boolean(movie && uid),
  });

  useEffect(() => {
    setStatusOpen(false);
    setAddListOpen(false);
  }, [movieStableKey]);

  useEffect(() => {
    if (!movie) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setStatusOpen(false);
        setAddListOpen(false);
        setCurrentModalMovie(null);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [movie, setCurrentModalMovie]);

  useEffect(() => {
    if (!statusOpen && !addListOpen) return;
    function onDocClick(ev: MouseEvent) {
      const footer = document.getElementById("modal-footer");
      const t = ev.target;
      if (footer && t instanceof Node && !footer.contains(t)) {
        setStatusOpen(false);
        setAddListOpen(false);
      }
    }
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [statusOpen, addListOpen]);

  if (!movie) return null;

  const m = movie;
  const raw = m.status || "to-watch";
  const tabKey = raw === "watched" ? "watched" : raw === "archive" ? "archive" : "to-watch";

  function close() {
    setStatusOpen(false);
    setAddListOpen(false);
    setCurrentModalMovie(null);
  }

  const rawOrigin = window.location.origin;
  const originParam =
    rawOrigin && rawOrigin !== "null" ? `&origin=${encodeURIComponent(rawOrigin)}` : "";

  const imdbUrl = m.imdbId ? `https://www.imdb.com/title/${m.imdbId}/` : null;

  async function onPickStatus(st: StatusKey) {
    if (!currentUser?.uid) return;
    const current =
      raw === "watched" ? "watched" : raw === "archive" ? "archive" : "to-watch";
    if (st === current) {
      setStatusOpen(false);
      return;
    }
    try {
      await setTitleStatusMutation.mutateAsync({
        uid: currentUser.uid,
        listMode: currentListMode,
        key: movieKey(m),
        status: st,
      });
      setCurrentModalMovie({ ...m, status: st });
    } catch (err: unknown) {
      console.error(err);
      window.alert(errorMessage(err) || "Failed to update.");
    }
    setStatusOpen(false);
  }

  function onAddListTriggerClick(e: ReactMouseEvent<HTMLButtonElement>) {
    e.stopPropagation();
    setStatusOpen(false);
    setAddListOpen((o) => !o);
  }

  async function onToggleListMembership(
    type: "personal" | "shared",
    listId: string,
    currentlyInList: boolean
  ) {
    if (!currentUser?.uid) return;
    if (listActionBusy) return;
    try {
      const key = movieKey(m);
      if (currentlyInList) {
        await removeTitleFromListMutation.mutateAsync({ uid: currentUser.uid, listId, key, type });
      } else {
        await addTitleMutation.mutateAsync({
          uid: currentUser.uid,
          listMode: type === "personal" ? { type: "personal", listId } : { type: "shared", listId, name: "" },
          item: m,
        });
      }
    } catch (err: unknown) {
      console.error(err);
      window.alert(errorMessage(err) || "Failed to update list.");
    }
  }

  const currentListButtonLabel = getCurrentListLabel(currentListMode, personalLists, sharedLists);

  const metaParts = [m.year || "", m.genre || ""].filter(Boolean).join(" ");
  const serviceChips = renderServiceChips(servicesForMovie(m, userCountryCode));
  const servicePart = serviceChips ? (
    <span dangerouslySetInnerHTML={{ __html: ` <span style="opacity:0.4">·</span> ${serviceChips}` }} />
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
          <button type="button" className="modal-close" id="modal-close" aria-label="Close" onClick={close}>
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
              src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(m.youtubeId)}?autoplay=1&rel=0&modestbranding=1&playsinline=1${originParam}`}
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
            <div className="modal-action-dropdown" data-dropdown="status">
              <button
                type="button"
                className="modal-action-btn modal-status-trigger"
                aria-haspopup="true"
                aria-expanded={statusOpen}
                onClick={(e) => {
                  e.stopPropagation();
                  setAddListOpen(false);
                  setStatusOpen((o) => !o);
                }}
              >
                <span className="modal-action-label">{STATUS_LABELS[tabKey]}</span>
              </button>
              <div
                className={`modal-action-dropdown-panel${statusOpen ? " open" : ""}`}
                role="menu"
              >
                {STATUS_ORDER.map((st) => {
                  const isActive = st === tabKey;
                  return (
                    <button
                      key={st}
                      type="button"
                      className="modal-action-dropdown-item"
                      role="menuitem"
                      data-status={st}
                      onClick={(e) => {
                        e.stopPropagation();
                        onPickStatus(st);
                      }}
                      dangerouslySetInnerHTML={{
                        __html: `${STATUS_LABELS[st]}${isActive ? " " + CHECK_SVG : ""}`,
                      }}
                    />
                  );
                })}
              </div>
            </div>

            <div className="modal-action-dropdown" data-dropdown="add-to-list">
              <button
                type="button"
                className="modal-action-btn modal-add-to-list-trigger"
                aria-haspopup="true"
                aria-expanded={addListOpen}
                disabled={listActionBusy}
                onClick={onAddListTriggerClick}
              >
                <span className="modal-action-label modal-list-label">{currentListButtonLabel}</span>
              </button>
              <div
                className={`modal-action-dropdown-panel modal-add-to-list-panel${addListOpen ? " open" : ""}`}
                role="menu"
              >
                {addListOpen && containingLoading && listsFetched ? (
                  <span className="modal-add-to-list-loading">Loading…</span>
                ) : null}
                {addListOpen && !containingLoading && !currentUser?.uid ? (
                  <span className="modal-add-to-list-empty">Sign in to manage lists</span>
                ) : null}
                {addListOpen && !containingLoading && currentUser?.uid
                  ? personalLists.map((l) => {
                      const listId = l.id;
                      const inList = containingLists.has(listId);
                      const label = displayListName(l.name);
                      return (
                        <button
                          key={`p-${listId}`}
                          type="button"
                          className="modal-action-dropdown-item"
                          role="menuitem"
                          disabled={listActionBusy}
                          onClick={(e) => {
                            e.stopPropagation();
                            void onToggleListMembership("personal", listId, inList);
                          }}
                        >
                          {label}
                          {inList ? (
                            <span dangerouslySetInnerHTML={{ __html: ` ${CHECK_SVG}` }} />
                          ) : null}
                        </button>
                      );
                    })
                  : null}
                {addListOpen && !containingLoading && currentUser?.uid
                  ? sharedLists.map((l) => {
                      const listId = l.id;
                      const inList = containingLists.has(listId);
                      const label = displayListName(l.name);
                      return (
                        <button
                          key={`s-${listId}`}
                          type="button"
                          className="modal-action-dropdown-item"
                          role="menuitem"
                          disabled={listActionBusy}
                          onClick={(e) => {
                            e.stopPropagation();
                            void onToggleListMembership("shared", listId, inList);
                          }}
                        >
                          {label}
                          {inList ? (
                            <span dangerouslySetInnerHTML={{ __html: ` ${CHECK_SVG}` }} />
                          ) : null}
                        </button>
                      );
                    })
                  : null}
                {addListOpen &&
                !containingLoading &&
                currentUser?.uid &&
                listsFetched &&
                personalLists.length === 0 &&
                sharedLists.length === 0 ? (
                  <span className="modal-add-to-list-empty">No lists</span>
                ) : null}
              </div>
            </div>

            {hasTrailer && m.youtubeId ? (
              <a
                href={`https://www.youtube.com/watch?v=${encodeURIComponent(m.youtubeId)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="modal-action-btn modal-youtube-link"
              >
                Watch on YouTube &#x2197;
              </a>
            ) : imdbUrl ? (
              <a
                href={imdbUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="modal-action-btn modal-youtube-link"
              >
                IMDb &#x2197;
              </a>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
