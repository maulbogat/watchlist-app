import { useEffect, useState, type ReactNode } from "react";
import { auth, checkUserAllowed, fbSignOut } from "../firebase.js";
import { useAppStore } from "../store/useAppStore.js";

/**
 * After Firebase Auth has a user, verifies `allowedUsers/{email}` before rendering children.
 * On failure: sets `accessDenied` in the store and signs out (App shows full-screen message).
 */
export function AllowlistGate({ children }: { children: ReactNode }) {
  const user = useAppStore((s) => s.currentUser);
  const setAccessDenied = useAppStore((s) => s.setAccessDenied);
  const [allowed, setAllowed] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (!user) {
      setAllowed(false);
      setChecking(false);
      return;
    }

    let cancelled = false;
    setChecking(true);
    setAllowed(false);

    (async () => {
      if (!user.email) {
        setAccessDenied("no_email");
        await fbSignOut(auth);
        if (!cancelled) {
          setChecking(false);
        }
        return;
      }
      const ok = await checkUserAllowed(user.email);
      if (cancelled) return;
      if (!ok) {
        setAccessDenied("not_invited");
        await fbSignOut(auth);
        setChecking(false);
        return;
      }
      setAccessDenied(null);
      setAllowed(true);
      setChecking(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [user?.uid, user?.email, setAccessDenied]);

  if (!user) return null;
  if (checking) {
    return <div className="react-migration-shell">Loading…</div>;
  }
  if (!allowed) return null;
  return <>{children}</>;
}
