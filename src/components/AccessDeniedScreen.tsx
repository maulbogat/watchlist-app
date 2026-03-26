import { useAppStore } from "../store/useAppStore.js";

export function AccessDeniedScreen() {
  const reason = useAppStore((s) => s.accessDenied);
  const setAccessDenied = useAppStore((s) => s.setAccessDenied);

  if (!reason) return null;

  const message =
    reason === "no_email"
      ? "Unable to verify your account. Please try again."
      : "You need an invitation to use this app. Please ask an existing user to invite you.";

  return (
    <div className="react-migration-shell" style={{ minHeight: "100vh", margin: 0 }}>
      <h1 className="react-migration-title">My Watchlist</h1>
      <p className="react-migration-meta" role="alert">
        {message}
      </p>
      <button
        type="button"
        className="auth-btn react-migration-signin-btn"
        onClick={() => setAccessDenied(null)}
      >
        Back to sign in
      </button>
    </div>
  );
}
