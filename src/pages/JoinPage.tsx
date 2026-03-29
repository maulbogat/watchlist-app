import { useEffect, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  auth,
  getSharedList,
  getIdTokenForApi,
  GoogleAuthProvider,
  signInWithPopup,
} from "../firebase.js";
import { useAuthUser } from "../hooks/useAuthUser.js";
import { useAppStore } from "../store/useAppStore.js";
import { saveLastList } from "../lib/storage.js";
import { invalidateUserListQueries } from "../hooks/useWatchlist.js";
import { errorMessage } from "../lib/utils.js";
import { toast } from "sonner";

type JoinResponse = { ok?: boolean; name?: string; error?: string };

export function JoinPage() {
  const { listId } = useParams<{ listId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { loading: authLoading } = useAuthUser();
  const user = useAppStore((s) => s.currentUser);
  const [pendingJoinAfterSignIn, setPendingJoinAfterSignIn] = useState(false);
  const sharedListQuery = useQuery({
    queryKey: ["sharedList", listId],
    queryFn: () => getSharedList(listId!),
    enabled: !!listId,
  });
  const sharedList = sharedListQuery.data ?? null;
  const loadingList = sharedListQuery.isLoading;

  const joinMutation = useMutation({
    mutationFn: async (): Promise<JoinResponse> => {
      if (!listId) throw new Error("Invalid invite link.");
      const token = await getIdTokenForApi();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetch("/api/join-shared-list", {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify({ listId }),
      });
      const data = (await response.json()) as JoinResponse;
      if (!response.ok || !data.ok) {
        const code = data.error || "";
        if (response.status === 403 && code === "invite_required") {
          throw new Error("invite_required");
        }
        throw new Error(code || "Failed to join list.");
      }
      return data;
    },
    onSuccess: async (data) => {
      if (!listId || !user?.uid) return;
      const mode = {
        type: "shared" as const,
        listId,
        name: data.name || sharedList?.name || "",
      };
      useAppStore.getState().setCurrentListMode(mode);
      saveLastList(user, mode);
      await invalidateUserListQueries(queryClient, user.uid);
      navigate(`/list/${listId}`, { replace: true });
    },
  });

  useEffect(() => {
    if (!pendingJoinAfterSignIn || !user?.uid || joinMutation.isPending) return;
    setPendingJoinAfterSignIn(false);
    joinMutation.mutate();
  }, [pendingJoinAfterSignIn, user, joinMutation]);

  async function handleSignInThenJoin() {
    setPendingJoinAfterSignIn(true);
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      await signInWithPopup(auth, provider);
    } catch (e: unknown) {
      setPendingJoinAfterSignIn(false);
      const code =
        e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "";
      if (code === "auth/cancelled-popup-request" || code === "auth/popup-closed-by-user") return;
      toast.error(errorMessage(e));
    }
  }

  const joinErrRaw = joinMutation.error ? errorMessage(joinMutation.error) : null;
  const joinErrorMessage =
    joinErrRaw === "invite_required"
      ? "You need an email invitation to join this list. Please ask a list member to invite you."
      : joinErrRaw;
  const listLoadErrorMessage = sharedListQuery.error ? errorMessage(sharedListQuery.error) : null;
  const notFoundMessage =
    !loadingList && listId && sharedListQuery.isSuccess && sharedList == null
      ? "Shared list not found."
      : null;
  const err = !listId
    ? "Invalid invite link."
    : joinErrorMessage || listLoadErrorMessage || notFoundMessage;

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
          You were invited to join <strong>{sharedList?.name || "this shared list"}</strong>.
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
          disabled={joinMutation.isPending}
          onClick={handleSignInThenJoin}
        >
          {joinMutation.isPending ? "Signing in…" : "Sign in with Google to join"}
        </button>
      ) : (
        <button
          type="button"
          className="auth-btn react-migration-signin-btn"
          disabled={joinMutation.isPending}
          onClick={() => joinMutation.mutate()}
        >
          {joinMutation.isPending ? "Joining…" : "Join List"}
        </button>
      )}
    </div>
  );
}
