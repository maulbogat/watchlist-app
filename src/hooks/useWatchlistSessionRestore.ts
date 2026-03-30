import { useEffect, useRef } from "react";
import { getLastListFromStorage, readFilterPreferences, saveLastList } from "../lib/storage.js";
import { useAppStore } from "../store/useAppStore.js";
import type { User } from "firebase/auth";
import { getSharedList } from "../firebase.js";
import type { PersonalList, SharedList } from "../types/index.js";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

/**
 * Restore `?join=`, last-opened list, and filter prefs into Zustand after list queries load.
 */
export function useWatchlistSessionRestore(
  user: User | null | undefined,
  personalLists: PersonalList[] | undefined,
  sharedLists: SharedList[] | undefined,
  listsReady: boolean
): void {
  const { listId } = useParams<{ listId?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const ranForRoute = useRef<string | null>(null);

  const joinId = searchParams.get("join");
  useEffect(() => {
    if (!joinId) return;
    navigate(`/join/${joinId}`, { replace: true });
  }, [joinId, navigate]);

  useEffect(() => {
    const uid = user?.uid;
    if (!uid || !listsReady || !Array.isArray(personalLists) || !Array.isArray(sharedLists)) return;
    const routeKey = `${uid}|${listId ?? ""}`;
    if (ranForRoute.current === routeKey) return;

    let cancelled = false;

    (async () => {
      const prefs = readFilterPreferences(user);
      if (prefs && !cancelled) {
        useAppStore.setState((s) => {
          let nextStatus = prefs.currentStatus;
          let nextSort = prefs.currentSort;
          if (prefs.currentStatus === "recently-added") {
            nextStatus = "to-watch";
            nextSort = "added-desc";
          }
          const validStatus =
            nextStatus === "all" ||
            nextStatus === "to-watch" ||
            nextStatus === "watched" ||
            nextStatus === "archive"
              ? nextStatus
              : s.currentStatus;
          const validSort =
            nextSort === "title-asc" ||
            nextSort === "release-desc" ||
            nextSort === "added-desc" ||
            nextSort === "added-asc"
              ? nextSort
              : s.currentSort;
          return {
            currentFilter:
              prefs.currentFilter === "both" ||
              prefs.currentFilter === "movie" ||
              prefs.currentFilter === "show"
                ? prefs.currentFilter
                : s.currentFilter,
            currentStatus: validStatus,
            currentGenre:
              typeof prefs.currentGenre === "string" ? prefs.currentGenre : s.currentGenre,
            currentSort: validSort,
            currentSearch:
              typeof prefs.currentSearch === "string" ? prefs.currentSearch : s.currentSearch,
            currentAddedByUid:
              typeof prefs.currentAddedByUid === "string"
                ? prefs.currentAddedByUid
                : s.currentAddedByUid,
          };
        });
      }

      if (listId) {
        if (listId === "personal") {
          if (!cancelled) {
            useAppStore.setState({ currentListMode: "personal" });
            saveLastList(user ?? null, "personal");
          }
          ranForRoute.current = routeKey;
          return;
        }

        const personalHit = personalLists.find((l) => l.id === listId);
        if (personalHit) {
          const mode = { type: "personal" as const, listId, name: personalHit.name };
          if (!cancelled) {
            useAppStore.setState({ currentListMode: mode });
            saveLastList(user ?? null, mode);
          }
          ranForRoute.current = routeKey;
          return;
        }

        let sharedHit = sharedLists.find((l) => l.id === listId);
        if (!sharedHit) {
          try {
            const fetched = await getSharedList(listId);
            if (
              fetched &&
              (fetched.ownerId === uid ||
                (Array.isArray(fetched.members) && fetched.members.includes(uid)))
            ) {
              sharedHit = fetched;
            }
          } catch {
            /* ignore: list id may be invalid or inaccessible */
          }
        }
        if (sharedHit && !cancelled) {
          const mode = { type: "shared" as const, listId: sharedHit.id, name: sharedHit.name };
          useAppStore.setState({ currentListMode: mode });
          saveLastList(user ?? null, mode);
          ranForRoute.current = routeKey;
          return;
        }

        if (!cancelled) {
          useAppStore.setState({ currentListMode: "personal" });
          saveLastList(user ?? null, "personal");
          navigate("/", { replace: true });
        }
        ranForRoute.current = routeKey;
        return;
      }

      const last = getLastListFromStorage(uid);
      if (!last || last === "personal") {
        if (!cancelled) useAppStore.setState({ currentListMode: "personal" });
        ranForRoute.current = routeKey;
        return;
      }

      const personalHit = personalLists.find((l) => l.id === last);
      if (personalHit) {
        if (!cancelled) {
          useAppStore.setState({
            currentListMode:
              last === "personal"
                ? "personal"
                : { type: "personal", listId: last, name: personalHit.name },
          });
          saveLastList(user ?? null, { type: "personal", listId: last, name: personalHit.name });
        }
        ranForRoute.current = routeKey;
        return;
      }

      let sharedHit = sharedLists.find((l) => l.id === last);
      if (!sharedHit) {
        try {
          const fetched = await getSharedList(last);
          if (
            fetched &&
            (fetched.ownerId === uid ||
              (Array.isArray(fetched.members) && fetched.members.includes(uid)))
          ) {
            sharedHit = fetched;
          }
        } catch {
          /* ignore: list id may be invalid or inaccessible */
        }
      }
      if (!cancelled && sharedHit) {
        const mode = {
          type: "shared" as const,
          listId: sharedHit.id,
          name: sharedHit.name,
        };
        useAppStore.setState({
          currentListMode: mode,
        });
        saveLastList(user ?? null, mode);
      } else if (!cancelled && last && last !== "personal") {
        useAppStore.setState({ currentListMode: "personal" });
      }

      ranForRoute.current = routeKey;
    })();

    return () => {
      cancelled = true;
    };
  }, [listId, listsReady, navigate, personalLists, sharedLists, user]);
}
