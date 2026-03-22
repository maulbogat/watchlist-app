import { useEffect, useState } from "react";
import { auth, onAuthStateChanged } from "../firebase.js";
import { useAppStore } from "../store/useAppStore.js";

export function useAuthUser(): { loading: boolean } {
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const setCurrentUser = useAppStore.getState().setCurrentUser;
    const unsub = onAuthStateChanged(auth, (u) => {
      setCurrentUser(u);
      setLoading(false);
    });
    return () => unsub();
  }, []);

  return { loading };
}
