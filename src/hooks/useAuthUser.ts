import { useEffect, useState } from "react";
import * as Sentry from "@sentry/react";
import { auth, onAuthStateChanged, syncUserDisplayNameToFirestore } from "../firebase.js";
import { setBookmarkletCookieWithMode } from "../lib/bookmarkletCookie.js";
import { clearUpcomingAlertsCache } from "../lib/storage.js";
import { useAppStore } from "../store/useAppStore.js";

export function useAuthUser(): { loading: boolean } {
  const [loading, setLoading] = useState(true);
  const currentUser = useAppStore((s) => s.currentUser);
  const currentListMode = useAppStore((s) => s.currentListMode);

  useEffect(() => {
    const setCurrentUser = useAppStore.getState().setCurrentUser;
    const unsub = onAuthStateChanged(auth, (u) => {
      setCurrentUser(u);
      setLoading(false);
      if (u) {
        Sentry.setUser({ id: u.uid });
        const label = u.displayName?.trim() || (u.email ? u.email.split("@")[0] : "") || "";
        void syncUserDisplayNameToFirestore(u.uid, label || null, u.photoURL ?? null);
      } else {
        Sentry.setUser(null);
      }
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    // Keep bookmarklet cookies in sync after sign-in/sign-out and list changes.
    void setBookmarkletCookieWithMode(currentUser, currentListMode);
    if (!currentUser) {
      clearUpcomingAlertsCache();
    }
  }, [currentUser, currentListMode]);

  useEffect(() => {
    if (!currentUser) return;
    // Firebase ID tokens expire; refresh cookie periodically while app is open.
    const id = window.setInterval(
      () => {
        void setBookmarkletCookieWithMode(currentUser, useAppStore.getState().currentListMode);
      },
      15 * 60 * 1000
    );
    return () => window.clearInterval(id);
  }, [currentUser]);

  return { loading };
}
