import { useEffect, useState, type ReactNode } from "react";
import type { User } from "firebase/auth";
import { auth, checkUserAllowed, fbSignOut } from "../firebase.js";
import { useAppStore } from "../store/useAppStore.js";
import { AuthLoadingSplash } from "./AuthLoadingSplash.js";

function allowlistCacheKey(u: User): string {
  return `${u.uid}:${u.email ?? ""}`;
}

/**
 * Survives React Strict Mode remounts so we do not flash the gate UI again after children
 * have already rendered (local useState would reset `checking` to true on remount).
 */
let allowlistVerifiedCacheKey: string | null = null;

/**
 * After Firebase Auth has a user, verifies `allowedUsers/{email}` before rendering children.
 * On failure: sets `accessDenied` in the store and signs out (App shows full-screen message).
 */
export function AllowlistGate({ children }: { children: ReactNode }) {
  const user = useAppStore((s) => s.currentUser);
  const setAccessDenied = useAppStore((s) => s.setAccessDenied);
  const initialKey = user ? allowlistCacheKey(user) : null;
  const cacheHit = initialKey != null && initialKey === allowlistVerifiedCacheKey;
  const [allowed, setAllowed] = useState(cacheHit);
  const [checking, setChecking] = useState(!cacheHit);

  useEffect(() => {
    if (!user) {
      allowlistVerifiedCacheKey = null;
      setAllowed(false);
      setChecking(false);
      return;
    }

    const key = allowlistCacheKey(user);
    const userEmail = user.email;
    if (key === allowlistVerifiedCacheKey) {
      setAccessDenied(null);
      setAllowed(true);
      setChecking(false);
      return;
    }

    let cancelled = false;
    setChecking(true);
    setAllowed(false);

    (async () => {
      if (!userEmail) {
        setAccessDenied("no_email");
        await fbSignOut(auth);
        if (!cancelled) {
          setChecking(false);
        }
        return;
      }
      const ok = await checkUserAllowed(userEmail);
      if (cancelled) return;
      if (!ok) {
        allowlistVerifiedCacheKey = null;
        setAccessDenied("not_invited");
        await fbSignOut(auth);
        setChecking(false);
        return;
      }
      allowlistVerifiedCacheKey = key;
      setAccessDenied(null);
      setAllowed(true);
      setChecking(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [user, setAccessDenied]);

  if (!user) return null;
  if (checking) {
    return <AuthLoadingSplash />;
  }
  if (!allowed) return null;
  return <>{children}</>;
}
