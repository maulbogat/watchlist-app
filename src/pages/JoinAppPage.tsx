import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  auth,
  getIdTokenForApi,
  GoogleAuthProvider,
  signInWithPopup,
} from "../firebase.js";
import { useAuthUser } from "../hooks/useAuthUser.js";
import { useAppStore } from "../store/useAppStore.js";
import { saveLastList } from "../lib/storage.js";
import { invalidateUserListQueries } from "../hooks/useWatchlist.js";
import { errorMessage } from "../lib/utils.js";

export function JoinAppPage() {
  const { inviteId } = useParams<{ inviteId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { loading: authLoading } = useAuthUser();
  const user = useAppStore((s) => s.currentUser);
  const setCurrentListMode = useAppStore((s) => s.setCurrentListMode);

  const [signingIn, setSigningIn] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [acceptBusy, setAcceptBusy] = useState(false);
  const processedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    processedKeyRef.current = null;
    setAcceptError(null);
  }, [inviteId]);

  useEffect(() => {
    processedKeyRef.current = null;
  }, [user?.uid]);

  useEffect(() => {
    if (authLoading || !user?.uid || !inviteId) return;
    const key = `${user.uid}::${inviteId}`;
    if (processedKeyRef.current === key) return;

    let cancelled = false;
    processedKeyRef.current = key;
    setAcceptBusy(true);
    setAcceptError(null);

    (async () => {
      try {
        const token = await getIdTokenForApi();
        if (!token) {
          setAcceptError("Could not get a sign-in token. Try again.");
          processedKeyRef.current = null;
          return;
        }
        const res = await fetch("/api/accept-invite", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ inviteId }),
        });
        const data = (await res.json()) as { ok?: boolean; error?: string; listId?: string | null };
        if (cancelled) return;
        if (!res.ok || !data.ok) {
          const code = data.error || "";
          processedKeyRef.current = null;
          if (code === "already_used") setAcceptError("This invitation was already used.");
          else if (code === "expired") setAcceptError("This invitation has expired.");
          else if (code === "wrong_email")
            setAcceptError("Sign in with the Google account that received the invite email.");
          else if (code === "not_found") setAcceptError("Invitation not found.");
          else if (code === "no_email_on_token")
            setAcceptError("Your Google account has no email on file. Use a different account.");
          else setAcceptError(data.error || "Could not accept this invitation.");
          return;
        }
        await invalidateUserListQueries(queryClient, user.uid);
        const lid = data.listId != null && String(data.listId).trim() ? String(data.listId).trim() : null;
        if (lid) {
          const mode = { type: "shared" as const, listId: lid, name: "" };
          setCurrentListMode(mode);
          saveLastList(user, mode);
          navigate(`/list/${lid}`, { replace: true });
        } else {
          navigate("/", { replace: true });
        }
      } catch (e: unknown) {
        if (!cancelled) {
          setAcceptError(errorMessage(e));
          processedKeyRef.current = null;
        }
      } finally {
        if (!cancelled) setAcceptBusy(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authLoading, user, inviteId, navigate, queryClient, setCurrentListMode]);

  async function handleSignIn() {
    setAcceptError(null);
    setSigningIn(true);
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      await signInWithPopup(auth, provider);
    } catch (e: unknown) {
      const code =
        e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "";
      if (code !== "auth/cancelled-popup-request" && code !== "auth/popup-closed-by-user") {
        setAcceptError(errorMessage(e));
      }
    } finally {
      setSigningIn(false);
    }
  }

  if (!inviteId) {
    return (
      <div className="react-migration-shell">
        <p className="react-migration-error" role="alert">
          Invalid invitation link.
        </p>
      </div>
    );
  }

  return (
    <div className="react-migration-shell">
      <h1 className="react-migration-title">Accept invitation</h1>
      <p className="react-migration-meta">
        {user
          ? "Confirming your invitation…"
          : "Sign in with Google to accept your invitation and join the app."}
      </p>
      {!user ? (
        <button
          type="button"
          className="auth-btn react-migration-signin-btn"
          disabled={signingIn || authLoading}
          onClick={() => void handleSignIn()}
        >
          {signingIn || authLoading ? "Please wait…" : "Sign in with Google"}
        </button>
      ) : null}
      {user && acceptBusy ? <p className="react-migration-meta">Working…</p> : null}
      {acceptError ? (
        <p className="react-migration-error" role="alert">
          {acceptError}
        </p>
      ) : null}
    </div>
  );
}
