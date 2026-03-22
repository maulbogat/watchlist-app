import { auth, onAuthStateChanged } from "./firebase.js";
import { getUserProfile } from "./data/user.js";

const params = new URLSearchParams(window.location.search);
const imdbId = params.get("imdbId") || params.get("i");

const statusEl = document.getElementById("status");
const backLink = document.getElementById("back-link");

function setStatus(msg: string, isError = false): void {
  if (!statusEl || !backLink) return;
  statusEl.textContent = msg;
  statusEl.style.color = isError ? "var(--error, #e74c3c)" : "var(--text)";
  backLink.style.display = "block";
  const p = new URLSearchParams(window.location.search);
  if (p.get("embed") === "1" && window.self === window.top) {
    setTimeout(() => {
      window.location.href = "./";
    }, 1500);
  }
}

const norm = (id: string | null) => (String(id || "").startsWith("tt") ? id : `tt${id || ""}`);
const nImdb = norm(imdbId);

interface AddBody {
  imdbId: string;
  watch_region: string;
  listId?: string;
  personalListId?: string;
}

if (!imdbId || !/^tt\d+$/.test(nImdb ?? "") || !statusEl || !backLink) {
  if (statusEl && backLink) {
    setStatus("Missing or invalid IMDb ID. Use the bookmarklet from an IMDb title page.", true);
  }
} else {
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      const msg = "Sign in on the watchlist first, then try again.";
      if (window.self !== window.top) {
        window.parent.postMessage({ type: "add-result", ok: false, error: msg }, "*");
      }
      if (window.opener) {
        window.opener.postMessage({ type: "add-result", ok: false, error: msg }, "*");
        setTimeout(() => {
          window.close();
        }, 300);
      }
      setStatus(msg, true);
      statusEl.innerHTML = 'Sign in on the <a href="./">watchlist</a> first, then try again.';
      return;
    }

    try {
      const token = await user.getIdToken();
      const profile = await getUserProfile(user.uid);
      const watchRegion = String(profile.country || "IL")
        .trim()
        .toUpperCase()
        .slice(0, 2);
      const body: AddBody = { imdbId: nImdb as string, watch_region: watchRegion };
      const listMatch = document.cookie.match(/bookmarklet_list_id=([^;]+)/);
      if (listMatch?.[1]) body.listId = decodeURIComponent(listMatch[1].trim());
      const plMatch = document.cookie.match(/bookmarklet_personal_list_id=([^;]+)/);
      if (plMatch?.[1]) body.personalListId = decodeURIComponent(plMatch[1].trim());

      const res = await fetch("/.netlify/functions/add-from-imdb", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });

      const data = (await res.json()) as { ok?: boolean; message?: string; error?: string };

      if (window.self !== window.top) {
        window.parent.postMessage(
          { type: "add-result", ok: data.ok, message: data.message, error: data.error },
          "*"
        );
      }
      if (window.opener) {
        window.opener.postMessage(
          { type: "add-result", ok: data.ok, message: data.message, error: data.error },
          "*"
        );
        setTimeout(() => {
          window.close();
        }, 300);
      }
      if (data.ok) {
        setStatus(data.message || "Added to watchlist!");
      } else {
        setStatus(data.error || "Failed to add.", true);
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : "Could not reach the server.";
      if (window.self !== window.top) {
        window.parent.postMessage({ type: "add-result", ok: false, error: errMsg }, "*");
      }
      if (window.opener) {
        window.opener.postMessage({ type: "add-result", ok: false, error: errMsg }, "*");
        setTimeout(() => {
          window.close();
        }, 300);
      }
      setStatus(errMsg, true);
    }
  });
}
