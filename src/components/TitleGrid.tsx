import { useState, useEffect, useCallback } from "react";
import { TitleCard } from "./TitleCard.js";
import { useAppStore } from "../store/useAppStore.js";
import { useRemoveTitle, useSetTitleStatus } from "../hooks/useMutations.js";
import { movieKey } from "../firebase.js";
import type { StatusKey, WatchlistItem } from "../types/index.js";
import { errorMessage } from "../lib/utils.js";
import { logEvent } from "../lib/axiom-logger.js";
import { toast } from "@/components/ui/use-toast";

interface TitleGridProps {
  visibleMovies: WatchlistItem[];
  currentStatus: string;
  totalLoaded: number;
  /** Set when viewing a shared list — attributes legacy items to the owner vs members. */
  sharedListOwnerId?: string | null;
  viewerDisplayName?: string | null;
  viewerPhotoUrl?: string | null;
  sharedListOwnerPhotoUrl?: string | null;
}

export function TitleGrid({
  visibleMovies,
  currentStatus,
  totalLoaded,
  sharedListOwnerId = null,
  viewerDisplayName = null,
  viewerPhotoUrl = null,
  sharedListOwnerPhotoUrl = null,
}: TitleGridProps) {
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
        void logEvent({
          type: "user.action",
          action: "status.change",
          tmdbId: movie.tmdbId ?? null,
          status,
          uid: currentUser.uid,
        }).catch(() => {});
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
      void logEvent({
        type: "user.action",
        action: "title.remove",
        tmdbId: movie.tmdbId ?? null,
        title,
        uid: currentUser.uid,
      }).catch(() => {});
      let removed = false;
      const timer = window.setTimeout(async () => {
        if (removed) return;
        removed = true;
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

      toast(`Removed ${title}`, {
        duration: 4000,
        action: {
          label: "Undo",
          onClick: () => {
            removed = true;
            window.clearTimeout(timer);
          },
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
            showAddedBy={isShared}
            viewerUid={currentUser?.uid ?? null}
            viewerDisplayName={viewerDisplayName}
            viewerPhotoUrl={viewerPhotoUrl}
            sharedListOwnerId={sharedListOwnerId}
            sharedListOwnerPhotoUrl={sharedListOwnerPhotoUrl}
            userCountryCode={userCountryCode}
            statusOpenKey={statusOpenKey}
            onSetStatusOpenKey={setStatusOpenKey}
            onStatusChange={handleStatusChange}
            onOpenModal={(movie: WatchlistItem) => {
              void logEvent({
                type: "user.action",
                action: "trailer.open",
                tmdbId: movie.tmdbId ?? null,
                title: movie.title,
                uid: currentUser?.uid ?? null,
              }).catch(() => {});
              setCurrentModalMovie(movie);
            }}
            onRequestRemove={scheduleRemove}
          />
        ))}
      </div>
    </>
  );
}
