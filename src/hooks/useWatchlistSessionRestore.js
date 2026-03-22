import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getLastList,
  readFilterPreferences,
  saveLastList,
} from "../lib/storage.js";
import { useAppStore } from "../store/useAppStore.js";
import { getSharedList } from "../../firebase.js";

/**
 * Restore `?join=`, last-opened list, and filter prefs into Zustand after list queries load.
 * Runs once per signed-in user after personal + shared list queries succeed.
 *
 * @param {{ uid: string } | null | undefined} user
 * @param {unknown[] | undefined} personalLists
 * @param {unknown[] | undefined} sharedLists
 * @param {boolean} listsReady — both list queries have completed (success or empty error)
 */
export function useWatchlistSessionRestore(user, personalLists, sharedLists, listsReady) {
  const queryClient = useQueryClient();
  const ranForUid = useRef(null);

  useEffect(() => {
    const uid = user?.uid;
    if (!uid || !listsReady || !Array.isArray(personalLists) || !Array.isArray(sharedLists)) return;
    if (ranForUid.current === uid) return;

    let cancelled = false;

    (async () => {
      const prefs = readFilterPreferences(user);
      if (prefs && !cancelled) {
        useAppStore.setState((s) => ({
          currentFilter:
            prefs.currentFilter === "both" ||
            prefs.currentFilter === "movie" ||
            prefs.currentFilter === "show"
              ? prefs.currentFilter
              : s.currentFilter,
          currentStatus:
            prefs.currentStatus === "to-watch" ||
            prefs.currentStatus === "watched" ||
            prefs.currentStatus === "archive" ||
            prefs.currentStatus === "recently-added"
              ? prefs.currentStatus
              : s.currentStatus,
          currentGenre: typeof prefs.currentGenre === "string" ? prefs.currentGenre : s.currentGenre,
        }));
      }

      const joinListId = new URLSearchParams(window.location.search).get("join");
      if (joinListId) {
        const apiBase = window.location.origin;
        try {
          const res = await fetch(`${apiBase}/.netlify/functions/join-shared-list`, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ listId: joinListId }),
          });
          const data = await res.json();
          if (cancelled) return;
          if (data.ok) {
            await queryClient.invalidateQueries({ queryKey: ["sharedLists", uid] });
            const mode = {
              type: "shared",
              listId: joinListId,
              name: data.name || "",
            };
            useAppStore.setState({ currentListMode: mode });
            saveLastList(user, mode);
          } else if (data.error) {
            console.warn("Join shared list failed:", data.error);
          }
        } catch (e) {
          console.warn("Join shared list failed:", e);
        }
        ranForUid.current = uid;
        return;
      }

      const last = getLastList(user);
      if (!last || last === "personal") {
        if (!cancelled) useAppStore.setState({ currentListMode: "personal" });
        ranForUid.current = uid;
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
        }
        ranForUid.current = uid;
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
        } catch (_) {}
      }
      if (!cancelled && sharedHit) {
        useAppStore.setState({
          currentListMode: {
            type: "shared",
            listId: sharedHit.id,
            name: sharedHit.name,
          },
        });
      } else if (!cancelled && last && last !== "personal") {
        useAppStore.setState({ currentListMode: "personal" });
      }

      ranForUid.current = uid;
    })();

    return () => {
      cancelled = true;
    };
  }, [user, personalLists, sharedLists, listsReady, queryClient]);
}
