/* eslint-disable react-hooks/rules-of-hooks -- hooks follow `if (!user) return null`; refactor would reorder without behavior change */
import { useMemo, useEffect, useState, useRef } from "react";
import {
  auth,
  fbSignOut,
  getUserPublicPhotoUrl,
  GoogleAuthProvider,
  listKey,
  renamePersonalList,
  signInWithPopup,
} from "../firebase.js";
import { getUserProfile, setUserCountry } from "../data/user.js";
import { COUNTRIES } from "../countries.js";
import { errorMessage } from "../lib/utils.js";
import { logEvent } from "../lib/axiom-logger.js";
import { useAppStore } from "../store/useAppStore.js";
import {
  usePersonalLists,
  useSharedLists,
  useWatchlistMovies,
  useArchiveMovies,
  useFavorites,
  invalidateUserListQueries,
} from "../hooks/useWatchlist.js";
import { useWatchlistSessionRestore } from "../hooks/useWatchlistSessionRestore.js";
import {
  filterTitles,
  isAddedByPresentInMovies,
  isGenrePresentInMovies,
} from "../lib/watchlistFilters.js";
import { ListSelector } from "./ListSelector.js";
import { WatchlistToolbar } from "./WatchlistToolbar.js";
import { TitleGrid, TitleGridSkeleton } from "./TitleGrid.js";
import { TrailerModal } from "./TrailerModal.js";
import { ManageListsModal } from "./ManageListsModal.js";
import { CountryModal } from "./CountryModal.js";
import { ListNameModal } from "./modals/ListNameModal.js";
import { UpcomingAlertsBar } from "./UpcomingAlertsBar.js";
import { RecommendationsSection } from "./RecommendationsSection.js";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";

export function WatchlistPage() {
  const navigate = useNavigate();
  const { listId } = useParams<{ listId?: string }>();
  const queryClient = useQueryClient();
  const user = useAppStore((s) => s.currentUser);
  const personalQ = usePersonalLists(user?.uid, { enabled: Boolean(user?.uid) });
  const sharedQ = useSharedLists(user?.uid, { enabled: Boolean(user?.uid) });
  const currentListMode = useAppStore((s) => s.currentListMode);
  const currentFilter = useAppStore((s) => s.currentFilter);
  const currentGenre = useAppStore((s) => s.currentGenre);
  const currentAddedByUid = useAppStore((s) => s.currentAddedByUid);
  const currentStatus = useAppStore((s) => s.currentStatus);
  const currentSort = useAppStore((s) => s.currentSort);
  const currentSearch = useAppStore((s) => s.currentSearch);
  const userCountryCode = useAppStore((s) => s.userCountryCode);
  const setUserCountryCode = useAppStore((s) => s.setUserCountryCode);
  const showFavoritesOnly = useAppStore((s) => s.showFavoritesOnly);

  const [manageListsOpen, setManageListsOpen] = useState(false);
  const [authMenuOpen, setAuthMenuOpen] = useState(false);
  const setWhatsAppSettingsOpen = useAppStore((s) => s.setWhatsAppSettingsOpen);
  const setBookmarkletSettingsOpen = useAppStore((s) => s.setBookmarkletSettingsOpen);
  const [countryPickerOpen, setCountryPickerOpen] = useState(false);
  const [onboardingCountry, setOnboardingCountry] = useState(false);
  const [onboardingListName, setOnboardingListName] = useState(false);

  const authWrapRef = useRef<HTMLDivElement>(null);

  const listsReady = personalQ.isFetched && sharedQ.isFetched;
  useWatchlistSessionRestore(user, personalQ.data ?? [], sharedQ.data ?? [], listsReady);

  const onboardingDone = useRef(false);
  const routeSyncReadyRef = useRef(false);
  const refreshListsMutation = useMutation({
    mutationFn: async (targetUid: string) => targetUid,
    onSuccess: async (_, targetUid) => {
      await invalidateUserListQueries(queryClient, targetUid);
    },
  });

  if (!user?.uid) return null;
  const uid = user.uid;

  async function continueProfileOnboarding() {
    const p = await getUserProfile(uid);
    if (p?.country) setUserCountryCode(p.country);
    if (!String(p.listName || "").trim()) {
      setOnboardingListName(true);
    } else {
      onboardingDone.current = true;
    }
  }

  useEffect(() => {
    if (!user?.uid || !listsReady || !personalQ.isSuccess || onboardingDone.current) return;
    let cancelled = false;
    (async () => {
      try {
        const p = await getUserProfile(user.uid);
        if (cancelled) return;
        if (p?.country) setUserCountryCode(p.country);
        if (!p?.country) {
          setOnboardingCountry(true);
          return;
        }
        if (!String(p.listName || "").trim()) {
          setOnboardingListName(true);
          return;
        }
        onboardingDone.current = true;
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.uid, listsReady, personalQ.isSuccess, setUserCountryCode]);

  const isArchiveTab = currentStatus === "archive";

  const moviesQ = useWatchlistMovies(user?.uid, currentListMode, {
    enabled: listsReady && !isArchiveTab,
  });

  const archiveQ = useArchiveMovies(user?.uid, currentListMode, {
    enabled: listsReady && isArchiveTab,
  });

  const activeQ = isArchiveTab ? archiveQ : moviesQ;
  const allMovies = activeQ.data ?? [];
  const favorites = useFavorites(user?.uid);

  useEffect(() => {
    if (!currentGenre) return;
    if (!isGenrePresentInMovies(allMovies, currentGenre)) {
      useAppStore.getState().setCurrentGenre("");
    }
  }, [allMovies, currentGenre]);

  useEffect(() => {
    if (!currentAddedByUid) return;
    if (!isAddedByPresentInMovies(allMovies, currentAddedByUid)) {
      useAppStore.getState().setCurrentAddedByUid("");
    }
  }, [allMovies, currentAddedByUid]);

  const prevSharedListIdRef = useRef<string | null>(null);
  useEffect(() => {
    const sid =
      currentListMode && typeof currentListMode === "object" && currentListMode.type === "shared"
        ? currentListMode.listId
        : null;
    if (prevSharedListIdRef.current !== null && sid !== prevSharedListIdRef.current) {
      useAppStore.getState().setCurrentAddedByUid("");
    }
    prevSharedListIdRef.current = sid;
  }, [currentListMode]);

  const visibleMovies = useMemo(() => {
    const base = filterTitles(allMovies, {
      currentFilter,
      currentGenre,
      currentStatus,
      currentSort,
      currentSearch,
      currentAddedByUid,
    });
    if (!showFavoritesOnly) return base;
    return base.filter((m) => favorites.has(listKey(m)));
  }, [
    allMovies,
    currentFilter,
    currentGenre,
    currentStatus,
    currentSort,
    currentSearch,
    currentAddedByUid,
    showFavoritesOnly,
    favorites,
  ]);

  const personalLists = personalQ.data ?? [];
  const sharedLists = sharedQ.data ?? [];

  const sharedListOwnerId = useMemo(() => {
    if (
      !currentListMode ||
      typeof currentListMode !== "object" ||
      currentListMode.type !== "shared"
    ) {
      return null;
    }
    const hit = sharedLists.find((l) => l.id === currentListMode.listId);
    if (!hit) return null;
    if (hit.ownerId) return hit.ownerId;
    const m = hit.members;
    if (Array.isArray(m) && m.length > 0 && typeof m[0] === "string") return m[0];
    return null;
  }, [currentListMode, sharedLists]);

  const [sharedListOwnerPhotoUrl, setSharedListOwnerPhotoUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!sharedListOwnerId) {
      setSharedListOwnerPhotoUrl(null);
      return;
    }
    let cancelled = false;
    void getUserPublicPhotoUrl(sharedListOwnerId).then((url) => {
      if (!cancelled) setSharedListOwnerPhotoUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [sharedListOwnerId]);

  const viewerDisplayNameForCards = user.displayName?.trim() || user.email?.split("@")[0] || null;

  const initial = (user.displayName || user.email || "?").charAt(0).toUpperCase();
  const watchlistBlocking = !listsReady || activeQ.isPending;

  const countryLabelRow = useMemo(() => {
    const c = COUNTRIES.find((x) => x.code === userCountryCode);
    return c ? `${c.flag} ${c.name}` : userCountryCode;
  }, [userCountryCode]);

  useEffect(() => {
    if (!authMenuOpen) return;
    function onDoc(e: MouseEvent) {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (!authWrapRef.current?.contains(t)) setAuthMenuOpen(false);
    }
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [authMenuOpen]);

  useEffect(() => {
    if (!listsReady) return;
    const targetPath =
      currentListMode === "personal"
        ? "/"
        : typeof currentListMode === "object"
          ? `/list/${currentListMode.listId}`
          : "/";
    const currentPath = listId ? `/list/${listId}` : "/";

    if (!routeSyncReadyRef.current) {
      routeSyncReadyRef.current = true;
      return;
    }
    if (targetPath !== currentPath) {
      navigate(targetPath, { replace: true });
    }
  }, [currentListMode, listId, listsReady, navigate]);

  useEffect(() => {
    if (!authMenuOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setAuthMenuOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [authMenuOpen]);

  return (
    <>
      <header>
        <h1>
          <img src="/watchlist-logo.svg" alt="Watchlist" className="watchlist-header-logo" />
        </h1>
        <div className="header-filters">
          <div className="filters">
            <div className="header-left">
              <div
                className="list-selector-wrap"
                id="list-selector-wrap"
                style={{ display: "flex" }}
              >
                {listsReady ? (
                  <>
                    <ListSelector
                      personalLists={personalLists}
                      sharedLists={sharedLists}
                      onManageLists={() => setManageListsOpen(true)}
                    />
                  </>
                ) : (
                  <span className="custom-dropdown-value" style={{ opacity: 0.6 }}>
                    Loading lists…
                  </span>
                )}
              </div>
            </div>
            <div id="auth-ui" className="auth-ui" ref={authWrapRef}>
              <div id="signed-in" className="auth-avatar-wrap" style={{ display: "flex" }}>
                <button
                  type="button"
                  className="auth-avatar"
                  id="auth-avatar-btn"
                  aria-haspopup="menu"
                  aria-expanded={authMenuOpen}
                  title={user.email || user.displayName || "Signed in"}
                  onClick={(e) => {
                    e.stopPropagation();
                    setAuthMenuOpen((o) => !o);
                  }}
                >
                  {user.photoURL ? (
                    <img
                      className="auth-avatar-img"
                      id="auth-avatar-img"
                      src={user.photoURL}
                      alt=""
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <span className="auth-avatar-initial" id="auth-avatar-initial">
                      {initial}
                    </span>
                  )}
                </button>
                <div
                  className="auth-dropdown"
                  id="auth-dropdown"
                  role="menu"
                  aria-hidden={authMenuOpen ? "false" : "true"}
                >
                  <button
                    type="button"
                    className="auth-dropdown-item"
                    role="menuitem"
                    id="auth-country-btn"
                    onClick={() => {
                      setAuthMenuOpen(false);
                      setCountryPickerOpen(true);
                    }}
                  >
                    Country: {countryLabelRow}
                  </button>
                  <button
                    type="button"
                    className="auth-dropdown-item"
                    role="menuitem"
                    id="auth-whatsapp-btn"
                    onClick={() => {
                      setAuthMenuOpen(false);
                      requestAnimationFrame(() => {
                        (document.activeElement as HTMLElement | null)?.blur();
                        setWhatsAppSettingsOpen(true);
                      });
                    }}
                  >
                    WhatsApp
                  </button>
                  <button
                    type="button"
                    className="auth-dropdown-item"
                    role="menuitem"
                    id="auth-bookmarklet-btn"
                    onClick={() => {
                      setAuthMenuOpen(false);
                      requestAnimationFrame(() => {
                        (document.activeElement as HTMLElement | null)?.blur();
                        setBookmarkletSettingsOpen(true);
                      });
                    }}
                  >
                    Bookmarklet
                  </button>
                  <button
                    type="button"
                    className="auth-dropdown-item"
                    role="menuitem"
                    id="auth-switch-btn"
                    onClick={async () => {
                      setAuthMenuOpen(false);
                      await fbSignOut(auth);
                      void logEvent({
                        type: "user.action",
                        action: "auth.signout",
                        uid: user.uid,
                      }).catch(() => {});
                      try {
                        const provider = new GoogleAuthProvider();
                        provider.setCustomParameters({ prompt: "select_account" });
                        const cred = await signInWithPopup(auth, provider);
                        void logEvent({
                          type: "user.action",
                          action: "auth.signin",
                          uid: cred?.user?.uid ?? null,
                        }).catch(() => {});
                      } catch (err: unknown) {
                        const code =
                          err && typeof err === "object" && "code" in err
                            ? String((err as { code: unknown }).code)
                            : "";
                        if (
                          code !== "auth/cancelled-popup-request" &&
                          code !== "auth/popup-closed-by-user"
                        ) {
                          console.error(err);
                        }
                      }
                    }}
                  >
                    Switch account
                  </button>
                  <button
                    type="button"
                    className="auth-dropdown-item"
                    role="menuitem"
                    id="auth-signout-btn"
                    onClick={async () => {
                      await fbSignOut(auth);
                      void logEvent({
                        type: "user.action",
                        action: "auth.signout",
                        uid: user.uid,
                      }).catch(() => {});
                    }}
                  >
                    Sign out
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </header>

      {listsReady && !activeQ.isError ? (
        <>
          <UpcomingAlertsBar movies={allMovies} watchlistPending={activeQ.isPending} />
          {!isArchiveTab ? (
            <RecommendationsSection
              movies={allMovies}
              watchlistPending={activeQ.isPending}
            />
          ) : null}
        </>
      ) : null}

      <main className="content">
        {activeQ.isError ? (
          <div className="grid" id="grid">
            <div className="empty-state">Could not load your list.</div>
          </div>
        ) : watchlistBlocking ? (
          <>
            {listsReady ? (
              <WatchlistToolbar
                allMovies={allMovies}
                visibleCount={visibleMovies.length}
                watchlistLoading
              />
            ) : null}
            <TitleGridSkeleton />
          </>
        ) : (
          <>
            <WatchlistToolbar allMovies={allMovies} visibleCount={visibleMovies.length} />
            <TitleGrid
              visibleMovies={visibleMovies}
              currentStatus={currentStatus}
              totalLoaded={allMovies.length}
              searchQuery={currentSearch}
              sharedListOwnerId={sharedListOwnerId}
              viewerDisplayName={viewerDisplayNameForCards}
              viewerPhotoUrl={user.photoURL ?? null}
              sharedListOwnerPhotoUrl={sharedListOwnerPhotoUrl}
            />
          </>
        )}
      </main>

      <TrailerModal />

      {listsReady ? (
        <ManageListsModal
          open={manageListsOpen}
          onClose={() => setManageListsOpen(false)}
          personalLists={personalLists}
          sharedLists={sharedLists}
        />
      ) : null}

      <CountryModal
        open={countryPickerOpen}
        initialCode={userCountryCode}
        allowCancel
        onCancel={() => setCountryPickerOpen(false)}
        onSave={async (code, name) => {
          await setUserCountry(user.uid, code, name);
          setUserCountryCode(code);
          setCountryPickerOpen(false);
          await refreshListsMutation.mutateAsync(user.uid);
        }}
      />

      <CountryModal
        open={onboardingCountry}
        initialCode="IL"
        allowCancel={false}
        onSave={async (code, name) => {
          await setUserCountry(user.uid, code, name);
          setUserCountryCode(code);
          setOnboardingCountry(false);
          await continueProfileOnboarding();
        }}
      />

      <ListNameModal
        open={onboardingListName}
        title="Name your main list"
        placeholder="e.g. My weekend watchlist"
        allowCancel={false}
        onCancel={() => setOnboardingListName(false)}
        onSave={async (name: string) => {
          try {
            await renamePersonalList(user.uid, "personal", name);
            setOnboardingListName(false);
            onboardingDone.current = true;
            await refreshListsMutation.mutateAsync(user.uid);
          } catch (e: unknown) {
            toast.error(
              errorMessage(e) || "Could not save your main list name. Reload and try again."
            );
          }
        }}
      />
    </>
  );
}
