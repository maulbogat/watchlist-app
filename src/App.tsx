import { useEffect, useState } from "react";
import { auth, GoogleAuthProvider, signInWithPopup } from "./firebase.js";
import { useAuthUser } from "./hooks/useAuthUser.js";
import { WatchlistPage } from "./components/WatchlistPage.js";
import { JoinPage } from "./pages/JoinPage.js";
import { AdminPage } from "./pages/AdminPage.js";
import { Navigate, Route, Routes, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useAppStore } from "./store/useAppStore.js";
import { Toaster } from "@/components/ui/toaster";

function isAuthError(err: unknown): err is { code?: string; message?: string } {
  return typeof err === "object" && err !== null;
}

function WatchlistAuthGate() {
  const { loading: authLoading } = useAuthUser();
  const user = useAppStore((s) => s.currentUser);
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);

  async function handleGoogleSignIn() {
    setSignInError(null);
    setSigningIn(true);
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      await signInWithPopup(auth, provider);
    } catch (err: unknown) {
      if (
        isAuthError(err) &&
        (err.code === "auth/cancelled-popup-request" || err.code === "auth/popup-closed-by-user")
      ) {
        return;
      }
      console.error("React shell sign-in:", err);
      const msg =
        isAuthError(err) && err.code === "auth/unauthorized-domain"
          ? `Add "${window.location.host}" in Firebase Console → Authentication → Settings → Authorized domains.`
          : isAuthError(err) && err.message
            ? err.message
            : "Sign-in failed.";
      setSignInError(msg);
    } finally {
      setSigningIn(false);
    }
  }

  if (authLoading) {
    return <div className="react-migration-shell">Loading…</div>;
  }

  if (!user) {
    return (
      <div className="react-migration-shell">
        <h1 className="react-migration-title">My Watchlist</h1>
        <p className="react-migration-meta react-migration-signin-note">
          Firebase Auth uses a <strong>separate session per origin</strong> (host + port). If you open
          this app on another URL than <code>{window.location.host}</code>, sign in again there. If
          sign-in fails with <code>auth/unauthorized-domain</code>, add that host in Firebase Console →
          Authentication → Authorized domains.
        </p>
        <p className="react-migration-meta">
          Lists, filters, grid, and trailer modal. Production build is deployed to Netlify.
        </p>
        <button
          type="button"
          className="auth-btn react-migration-signin-btn"
          disabled={signingIn}
          onClick={handleGoogleSignIn}
        >
          {signingIn ? "Signing in…" : "Sign in with Google"}
        </button>
        {signInError ? (
          <p className="react-migration-error" role="alert">
            {signInError}
          </p>
        ) : null}
      </div>
    );
  }

  return <WatchlistPage />;
}

export default function App() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();

  const joinId = searchParams.get("join");
  useEffect(() => {
    if (!joinId) return;
    if (location.pathname.startsWith("/join/")) return;
    navigate(`/join/${joinId}`, { replace: true });
  }, [joinId, navigate, location.pathname]);

  return (
    <>
      <Routes>
        <Route path="/" element={<WatchlistAuthGate />} />
        <Route path="/list/:listId" element={<WatchlistAuthGate />} />
        <Route path="/join/:listId" element={<JoinPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toaster />
    </>
  );
}
