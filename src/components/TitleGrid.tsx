import { useState, useEffect, useCallback } from "react";
import { TitleCard } from "./TitleCard.js";
import { useAppStore } from "../store/useAppStore.js";
import { useRemoveTitle, useSetTitleStatus } from "../hooks/useMutations.js";
import { movieKey } from "../firebase.js";
import type { StatusKey, WatchlistItem } from "../types/index.js";
import { errorMessage } from "../lib/utils.js";

type ToastState = { id: string; title: string; undo: () => void } | null;

interface TitleGridProps {
  visibleMovies: WatchlistItem[];
  currentStatus: string;
  totalLoaded: number;
}

export function TitleGrid({ visibleMovies, currentStatus, totalLoaded }: TitleGridProps) {
  const currentUser = useAppStore((s) => s.currentUser);
  const currentListMode = useAppStore((s) => s.currentListMode);
  const isShared =
    currentListMode &&
    typeof currentListMode === "object" &&
    currentListMode.type === "shared";
  const userCountryCode = useAppStore((s) => s.userCountryCode);
  const setCurrentModalMovie = useAppStore((s) => s.setCurrentModalMovie);
  const setTitleStatusMutation = useSetTitleStatus();
  const removeTitleMutation = useRemoveTitle();

  const [statusOpenKey, setStatusOpenKey] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState>(null);

  useEffect(() => {
    function onDocClick() {
      setStatusOpenKey(null);
    }
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, []);

  const handleStatusChange = useCallback(
    async (movie: WatchlistItem, status: StatusKey) => {
      if (!currentUser?.uid) return;
      try {
        await setTitleStatusMutation.mutateAsync({
          uid: currentUser.uid,
          listMode: currentListMode,
          key: movieKey(movie),
          status,
        });
      } catch (err: unknown) {
        console.error(err);
        window.alert(errorMessage(err) || "Failed to update.");
      }
    },
    [currentUser?.uid, currentListMode, setTitleStatusMutation]
  );

  const scheduleRemove = useCallback(
    (movie: WatchlistItem) => {
      if (!currentUser?.uid) return;
      const title = String(movie.title || "").trim() || "Title";
      let removed = false;
      const id = `rm-${Date.now()}`;
      const timer = window.setTimeout(async () => {
        if (removed) return;
        removed = true;
        setToast((t) => (t?.id === id ? null : t));
        try {
          await removeTitleMutation.mutateAsync({
            uid: currentUser.uid,
            listMode: currentListMode,
            key: movieKey(movie),
          });
        } catch (err: unknown) {
          console.error(err);
          window.alert(errorMessage(err) || "Failed to remove.");
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
    [currentUser?.uid, currentListMode, removeTitleMutation]
  );

  if (!visibleMovies.length) {
    const messages: Record<string, string> = {
      "recently-added": "No recently added titles.",
      "to-watch": "No titles to watch yet.",
      watched: "No watched titles yet.",
      archive: "No archived titles yet.",
    };
    const base = messages[currentStatus] ?? "No titles match your filters.";
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
            onOpenModal={(movie: WatchlistItem) => setCurrentModalMovie(movie)}
            onRequestRemove={scheduleRemove}
          />
        ))}
      </div>
      <ToastMount toast={toast} />
    </>
  );
}

interface ToastMountProps {
  toast: ToastState;
}

function ToastMount({ toast }: ToastMountProps) {
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
