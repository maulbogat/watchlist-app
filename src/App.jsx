import { useState } from "react";
import { auth, GoogleAuthProvider, signInWithPopup } from "../firebase.js";
import { useAuthUser } from "./hooks/useAuthUser.js";
import { WatchlistPage } from "./components/WatchlistPage.jsx";

export default function App() {
  const { user, loading: authLoading } = useAuthUser();
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState(null);

  async function handleGoogleSignIn() {
    setSignInError(null);
    setSigningIn(true);
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      await signInWithPopup(auth, provider);
    } catch (err) {
      if (
        err?.code === "auth/cancelled-popup-request" ||
        err?.code === "auth/popup-closed-by-user"
      ) {
        return;
      }
      console.error("React shell sign-in:", err);
      const msg =
        err?.code === "auth/unauthorized-domain"
          ? `Add "${window.location.host}" in Firebase Console → Authentication → Settings → Authorized domains.`
          : err?.message || "Sign-in failed.";
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
        <h1 className="react-migration-title">React shell</h1>
        <p className="react-migration-meta react-migration-signin-note">
          Firebase keeps a <strong>separate session per site URL</strong>. If the
          legacy app runs on another port or host (not{" "}
          <code>{window.location.host}</code>), sign in here too.
        </p>
        <p className="react-migration-meta">
          This is the watchlist app (lists, filters, grid, trailer modal). The same build is deployed
          to Netlify.
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

  return <WatchlistPage user={user} />;
}
