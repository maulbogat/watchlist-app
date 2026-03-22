import { useEffect, useState } from "react";
import { auth, onAuthStateChanged } from "../../firebase.js";

/**
 * Firebase Auth user for React; mirrors `onAuthStateChanged` subscription.
 * @returns {{ user: { uid: string } | null, loading: boolean }}
 */
export function useAuthUser() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return () => unsub();
  }, []);

  return { user, loading };
}
