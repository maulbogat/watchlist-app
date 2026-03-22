import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { SharedList } from "../types/index.js";
import { auth, getSharedList, GoogleAuthProvider, signInWithPopup } from "../firebase.js";
import { useAuthUser } from "../hooks/useAuthUser.js";
import { useAppStore } from "../store/useAppStore.js";
import { saveLastList } from "../lib/storage.js";
import { invalidateUserListQueries } from "../hooks/useWatchlist.js";
import { errorMessage } from "../lib/utils.js";

type JoinResponse = { ok?: boolean; name?: string; error?: string };

export function JoinPage() {
  const { listId } = useParams<{ listId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, loading: authLoading } = useAuthUser();

  const [list, setList] = useState<SharedList | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [joining, setJoining] = useState(false);
  const [pendingJoinAfterSignIn, setPendingJoinAfterSignIn] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!listId) {
      setLoadingList(false);
      setErr("Invalid invite link.");
      return () => {
        cancelled = true;
      };
    }

    setLoadingList(true);
    setErr(null);
    void getSharedList(listId)
      .then((res) => {
        if (cancelled) return;
        if (!res) {
          setErr("Shared list not found.");
          setList(null);
          return;
        }
        setList(res);
      })
      .catch((e: unknown) => {
        if (!cancelled) setErr(errorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoadingList(false);
      });

    return () => {
      cancelled = true;
    };
  }, [listId]);

  const joinNow = useCallback(async () => {
    if (!listId || !user?.uid) return;
    setJoining(true);
    setErr(null);
    try {
      const res = await fetch("/.netlify/functions/join-shared-list", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listId }),
      });
      const data = (await res.json()) as JoinResponse;
      if (!data.ok) {
        setErr(data.error || "Failed to join list.");
        return;
      }

      const mode = {
        type: "shared" as const,
        listId,
        name: data.name || list?.name || "",
      };
      useAppStore.getState().setCurrentListMode(mode);
      saveLastList(user, mode);
      await invalidateUserListQueries(queryClient, user.uid);
      navigate(`/list/${listId}`, { replace: true });
    } catch (e: unknown) {
      setErr(errorMessage(e));
    } finally {
      setJoining(false);
    }
  }, [listId, list?.name, navigate, queryClient, user]);

  useEffect(() => {
    if (!pendingJoinAfterSignIn || !user?.uid || joining) return;
    setPendingJoinAfterSignIn(false);
    void joinNow();
  }, [pendingJoinAfterSignIn, user, joining, joinNow]);

  async function handleSignInThenJoin() {
    setErr(null);
    setPendingJoinAfterSignIn(true);
    setJoining(true);
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      await signInWithPopup(auth, provider);
    } catch (e: unknown) {
      setPendingJoinAfterSignIn(false);
      setJoining(false);
      const code =
        e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "";
      if (code === "auth/cancelled-popup-request" || code === "auth/popup-closed-by-user") return;
      setErr(errorMessage(e));
    } finally {
      if (!pendingJoinAfterSignIn) setJoining(false);
    }
  }

  if (!listId) {
    return (
      <div className="react-migration-shell">
        <h1 className="react-migration-title">Invalid invite</h1>
        <p className="react-migration-error">The invite link is missing a list id.</p>
        <Link className="auth-btn react-migration-signin-btn" to="/">
          Go to my watchlist
        </Link>
      </div>
    );
  }

  return (
    <div className="react-migration-shell">
      <h1 className="react-migration-title">Join shared list</h1>
      {loadingList ? (
        <p className="react-migration-meta">Loading invite…</p>
      ) : (
        <p className="react-migration-meta">
          You were invited to join <strong>{list?.name || "this shared list"}</strong>.
        </p>
      )}

      {err ? (
        <>
          <p className="react-migration-error" role="alert">
            {err}
          </p>
          <Link className="auth-btn react-migration-signin-btn" to="/">
            Go to my watchlist
          </Link>
        </>
      ) : authLoading || loadingList ? null : !user ? (
        <button
          type="button"
          className="auth-btn react-migration-signin-btn"
          disabled={joining}
          onClick={handleSignInThenJoin}
        >
          {joining ? "Signing in…" : "Sign in with Google to join"}
        </button>
      ) : (
        <button
          type="button"
          className="auth-btn react-migration-signin-btn"
          disabled={joining}
          onClick={() => void joinNow()}
        >
          {joining ? "Joining…" : "Join List"}
        </button>
      )}
    </div>
  );
}
