import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAppStore, STATUS_ORDER, STATUS_LABELS, CHECK_SVG } from "../store/useAppStore.js";
import { hasPlayableTrailerYoutubeId, renderServiceChips, servicesForMovie } from "../lib/movieDisplay.js";
import { persistTitleStatus } from "../lib/titleListActions.js";
import { invalidateUserListQueries, usePersonalLists, useSharedLists } from "../hooks/useWatchlist.js";
import { getListLabel } from "../lib/listModeDisplay.js";
import { getListsContainingMovie } from "../lib/listsContainingMovie.js";
import { displayListName } from "../lib/utils.js";
import {
  addToPersonalList,
  addToSharedList,
  movieKey,
  removeFromPersonalList,
  removeFromSharedList,
} from "../../firebase.js";

export function TrailerModal({ user }) {
  const queryClient = useQueryClient();
  const movie = useAppStore((s) => s.currentModalMovie);
  const setCurrentModalMovie = useAppStore((s) => s.setCurrentModalMovie);
  const userCountryCode = useAppStore((s) => s.userCountryCode);
  const currentListMode = useAppStore((s) => s.currentListMode);

  const personalQ = usePersonalLists(user?.uid, { enabled: Boolean(user?.uid) });
  const sharedQ = useSharedLists(user?.uid, { enabled: Boolean(user?.uid) });
  /** Stable when `data` is undefined — a bare `?? []` creates a new array every render and retriggers effects. */
  const personalLists = useMemo(() => personalQ.data ?? [], [personalQ.data]);
  const sharedLists = useMemo(() => sharedQ.data ?? [], [sharedQ.data]);

  /** Close dropdowns when switching titles, not when the same row gets a new object (e.g. status). */
  const movieStableKey = movie ? movieKey(movie) : null;

  const [statusOpen, setStatusOpen] = useState(false);
  const [addListOpen, setAddListOpen] = useState(false);
  const [containingLoading, setContainingLoading] = useState(false);
  const [containingIds, setContainingIds] = useState(() => new Set());
  const [listActionBusy, setListActionBusy] = useState(false);

  const listsFetched = personalQ.isFetched && sharedQ.isFetched;

  useEffect(() => {
    setStatusOpen(false);
    setAddListOpen(false);
    setContainingLoading(false);
    setContainingIds(new Set());
  }, [movieStableKey]);

  useEffect(() => {
    if (!addListOpen || movieStableKey == null || !user?.uid) {
      if (!addListOpen) setContainingLoading(false);
      return;
    }
    if (!listsFetched) {
      setContainingLoading(true);
      return;
    }
    const currentMovie = useAppStore.getState().currentModalMovie;
    if (!currentMovie || movieKey(currentMovie) !== movieStableKey) {
      setContainingLoading(false);
      return;
    }
    let cancelled = false;
    setContainingLoading(true);
    void getListsContainingMovie(currentMovie, user.uid, personalLists, sharedLists)
      .then((set) => {
        if (!cancelled) setContainingIds(set);
      })
      .catch(() => {
        if (!cancelled) setContainingIds(new Set());
      })
      .finally(() => {
        if (!cancelled) setContainingLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [addListOpen, movieStableKey, user?.uid, listsFetched, personalLists, sharedLists]);

  useEffect(() => {
    if (!movie) return;
    function onKey(e) {
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
    function onDocClick(ev) {
      const footer = document.getElementById("modal-footer");
      if (footer && !footer.contains(ev.target)) {
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

  async function onPickStatus(st) {
    const current =
      raw === "watched" ? "watched" : raw === "archive" ? "archive" : "to-watch";
    if (st === current) {
      setStatusOpen(false);
      return;
    }
    try {
      await persistTitleStatus(user.uid, currentListMode, m, st);
      setCurrentModalMovie({ ...m, status: st });
      invalidateUserListQueries(queryClient, user.uid);
    } catch (err) {
      console.error(err);
      window.alert(err?.message || "Failed to update.");
    }
    setStatusOpen(false);
  }

  function onAddListTriggerClick(e) {
    e.stopPropagation();
    setStatusOpen(false);
    setAddListOpen((o) => !o);
  }

  async function onToggleListMembership(type, listId, currentlyInList) {
    if (listActionBusy) return;
    setListActionBusy(true);
    try {
      if (currentlyInList) {
        if (type === "personal") await removeFromPersonalList(user.uid, listId, movieKey(m));
        else await removeFromSharedList(listId, movieKey(m));
      } else {
        if (type === "personal") await addToPersonalList(user.uid, listId, m);
        else await addToSharedList(listId, m);
      }
      setContainingIds((prev) => {
        const next = new Set(prev);
        if (currentlyInList) next.delete(listId);
        else next.add(listId);
        return next;
      });
      invalidateUserListQueries(queryClient, user.uid);
    } catch (err) {
      console.error(err);
      window.alert(err?.message || "Failed to update list.");
    } finally {
      setListActionBusy(false);
    }
  }

  const currentListButtonLabel = getListLabel(currentListMode, personalLists, sharedLists);

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
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="modal">
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
          {hasTrailer ? (
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
                {addListOpen && containingLoading ? (
                  <span className="modal-add-to-list-loading">Loading…</span>
                ) : null}
                {addListOpen && !containingLoading && !user?.uid ? (
                  <span className="modal-add-to-list-empty">Sign in to manage lists</span>
                ) : null}
                {addListOpen && !containingLoading && user?.uid
                  ? personalLists.map((l) => {
                      const listId = l.id;
                      const inList = containingIds.has(listId);
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
                {addListOpen && !containingLoading && user?.uid
                  ? sharedLists.map((l) => {
                      const listId = l.id;
                      const inList = containingIds.has(listId);
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
                user?.uid &&
                listsFetched &&
                personalLists.length === 0 &&
                sharedLists.length === 0 ? (
                  <span className="modal-add-to-list-empty">No lists</span>
                ) : null}
              </div>
            </div>

            {hasTrailer ? (
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
