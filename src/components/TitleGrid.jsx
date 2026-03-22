import { useState, useEffect, useCallback } from "react";
import { TitleCard } from "./TitleCard.jsx";
import { useAppStore } from "../store/useAppStore.js";
import { persistTitleStatus, persistRemoveTitle } from "../lib/titleListActions.js";
import { invalidateUserListQueries } from "../hooks/useWatchlist.js";
import { useQueryClient } from "@tanstack/react-query";
import { movieKey } from "../../firebase.js";

/**
 * @param {{ user: { uid: string }, visibleMovies: any[], currentStatus: string, totalLoaded: number }} props
 */
export function TitleGrid({ user, visibleMovies, currentStatus, totalLoaded }) {
  const queryClient = useQueryClient();
  const currentListMode = useAppStore((s) => s.currentListMode);
  const isShared =
    currentListMode &&
    typeof currentListMode === "object" &&
    currentListMode.type === "shared";
  const userCountryCode = useAppStore((s) => s.userCountryCode);
  const setCurrentModalMovie = useAppStore((s) => s.setCurrentModalMovie);

  const [statusOpenKey, setStatusOpenKey] = useState(null);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    function onDocClick() {
      setStatusOpenKey(null);
    }
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, []);

  const invalidate = useCallback(() => {
    invalidateUserListQueries(queryClient, user.uid);
  }, [queryClient, user.uid]);

  const handleStatusChange = useCallback(
    async (movie, status) => {
      try {
        await persistTitleStatus(user.uid, currentListMode, movie, status);
        invalidate();
      } catch (err) {
        console.error(err);
        window.alert(err?.message || "Failed to update.");
      }
    },
    [user.uid, currentListMode, invalidate]
  );

  const scheduleRemove = useCallback(
    (movie) => {
      const title = String(movie.title || "").trim() || "Title";
      let removed = false;
      const id = `rm-${Date.now()}`;
      const timer = window.setTimeout(async () => {
        if (removed) return;
        removed = true;
        setToast((t) => (t?.id === id ? null : t));
        try {
          await persistRemoveTitle(user.uid, currentListMode, movie);
          invalidate();
        } catch (err) {
          console.error(err);
          window.alert(err?.message || "Failed to remove.");
        }
      }, 4000);

      setToast({
        id,
        title,
        undo: () => {
          removed = true;
          window.clearTimeout(timer);
          setToast(null);
        },
      });
    },
    [user.uid, currentListMode, invalidate]
  );

  if (!visibleMovies.length) {
    const messages = {
      "recently-added": "No recently added titles.",
      "to-watch": "No titles to watch yet.",
      watched: "No watched titles yet.",
      archive: "No archived titles yet.",
    };
    const base = messages[currentStatus] || "No titles match your filters.";
    const listTrulyEmpty = totalLoaded === 0;
    const withImdb =
      listTrulyEmpty && currentStatus === "to-watch" ? (
        <>
          {isShared ? "This shared list is empty. " : "Your list is empty. "}
          Add titles from{" "}
          <a href="/bookmarklet.html" className="empty-state-link">
            IMDb
          </a>
          .
        </>
      ) : (
        base
      );
    return (
      <>
        <div className="grid" id="grid">
          <div className="empty-state">{withImdb}</div>
        </div>
        <ToastMount toast={toast} />
      </>
    );
  }

  return (
    <>
      <div className="grid" id="grid">
        {visibleMovies.map((m) => (
          <TitleCard
            key={movieKey(m)}
            movie={m}
            userCountryCode={userCountryCode}
            statusOpenKey={statusOpenKey}
            onSetStatusOpenKey={setStatusOpenKey}
            onStatusChange={handleStatusChange}
            onOpenModal={(movie) => setCurrentModalMovie(movie)}
            onRequestRemove={scheduleRemove}
          />
        ))}
      </div>
      <ToastMount toast={toast} />
    </>
  );
}

function ToastMount({ toast }) {
  if (!toast) return null;
  return (
    <div id="toast-container" className="toast-container" aria-live="polite">
      <div className="toast">
        <span>
          Removed {toast.title}
        </span>
        {toast.undo ? (
          <button type="button" className="toast-undo-btn" onClick={toast.undo}>
            Undo
          </button>
        ) : null}
      </div>
    </div>
  );
}
