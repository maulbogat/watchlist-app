import { useState, useEffect, useCallback } from "react";
import { TitleCard } from "./TitleCard.js";
import { useAppStore } from "../store/useAppStore.js";
import { useRemoveTitle, useSetTitleStatus, useToggleFavorite } from "../hooks/useMutations.js";
import { useFavorites } from "../hooks/useWatchlist.js";
import { listKey } from "../firebase.js";
import type { StatusKey, WatchlistItem } from "../types/index.js";
import { errorMessage } from "../lib/utils.js";
import { logEvent } from "../lib/axiom-logger.js";
import { toast } from "@/components/ui/use-toast";
import { toast as sonnerToast } from "sonner";

const TITLE_GRID_SKELETON_COUNT = 10;

/** Placeholder grid while watchlist data loads — matches live card layout to avoid jump. */
export function TitleGridSkeleton() {
  return (
    <div className="grid" id="grid" aria-hidden="true">
      {Array.from({ length: TITLE_GRID_SKELETON_COUNT }, (_, i) => (
        <div key={i} className="card card--skeleton">
          <div className="thumb-wrap skeleton-shimmer" />
          <div className="card-info card-info--skeleton">
            <span className="skeleton-line skeleton-line--title skeleton-shimmer" />
            <span className="skeleton-line skeleton-line--meta skeleton-shimmer" />
            <span className="skeleton-service-row skeleton-shimmer" />
          </div>
        </div>
      ))}
    </div>
  );
}

interface TitleGridProps {
  visibleMovies: WatchlistItem[];
  currentStatus: string;
  totalLoaded: number;
  /** Trimmed search query — used for dedicated empty copy when search yields no rows. */
  searchQuery?: string;
  /** Set when viewing a shared list — attributes legacy items to the owner vs members. */
  sharedListOwnerId?: string | null;
  viewerDisplayName?: string | null;
  viewerPhotoUrl?: string | null;
  sharedListOwnerPhotoUrl?: string | null;
}

export function TitleGrid({
  visibleMovies,
  currentStatus: _currentStatus,
  totalLoaded,
  searchQuery = "",
  sharedListOwnerId = null,
  viewerDisplayName = null,
  viewerPhotoUrl = null,
  sharedListOwnerPhotoUrl = null,
}: TitleGridProps) {
  const currentUser = useAppStore((s) => s.currentUser);
  const currentListMode = useAppStore((s) => s.currentListMode);
  const isShared =
    currentListMode && typeof currentListMode === "object" && currentListMode.type === "shared";
  const userCountryCode = useAppStore((s) => s.userCountryCode);
  const setCurrentModalMovie = useAppStore((s) => s.setCurrentModalMovie);
  const setTitleStatusMutation = useSetTitleStatus();
  const removeTitleMutation = useRemoveTitle();
  const toggleFavoriteMutation = useToggleFavorite();
  const favorites = useFavorites(currentUser?.uid, currentListMode);

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
          key: listKey(movie),
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
        sonnerToast.error(errorMessage(err) || "Failed to update.");
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
            key: listKey(movie),
          });
        } catch (err: unknown) {
          console.error(err);
          sonnerToast.error(errorMessage(err) || "Failed to remove.");
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
    const listTrulyEmpty = totalLoaded === 0;
    const q = searchQuery.trim();

    if (q && !listTrulyEmpty) {
      return (
        <div className="grid" id="grid">
          <p className="watchlist-empty-message">No titles match &ldquo;{q}&rdquo;</p>
        </div>
      );
    }

    if (listTrulyEmpty) {
      return (
        <div className="grid" id="grid">
          <p className="watchlist-empty-message">
            Your list is empty. Add titles using the{" "}
            <a href="/bookmarklet.html" className="empty-state-link">
              bookmarklet
            </a>{" "}
            or{" "}
            <button
              type="button"
              className="watchlist-empty-inline-btn"
              onClick={() => useAppStore.getState().setWhatsAppSettingsOpen(true)}
            >
              WhatsApp
            </button>
            .
          </p>
        </div>
      );
    }

    return (
      <div className="grid" id="grid">
        <div className="empty-state">No titles match your filters.</div>
      </div>
    );
  }

  return (
    <>
      <div className="grid" id="grid">
        {visibleMovies.map((m) => (
          <TitleCard
            key={listKey(m)}
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
            isFavorite={favorites.has(listKey(m))}
            {...(currentUser?.uid
              ? {
                  onToggleFavorite: () => {
                    const registryId = listKey(m);
                    const nowFavorite = !favorites.has(registryId);
                    void toggleFavoriteMutation.mutateAsync({
                      uid: currentUser.uid,
                      listMode: currentListMode,
                      registryId,
                      isFavorite: nowFavorite,
                    });
                  },
                }
              : {})}
          />
        ))}
      </div>
    </>
  );
}
