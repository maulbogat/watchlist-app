import { auth, onAuthStateChanged, getUserProfile } from "./firebase.js";

const params = new URLSearchParams(window.location.search);
const imdbId = params.get("imdbId") || params.get("i");

const statusEl = document.getElementById("status");
const backLink = document.getElementById("back-link");

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.style.color = isError ? "var(--error, #e74c3c)" : "var(--text)";
  backLink.style.display = "block";
  const params = new URLSearchParams(window.location.search);
  if (params.get("embed") === "1" && window.self === window.top) {
    setTimeout(() => { window.location.href = "./"; }, 1500);
  }
}

const norm = (id) => (String(id || "").startsWith("tt") ? id : `tt${id || ""}`);
const nImdb = norm(imdbId);

if (!imdbId || !/^tt\d+$/.test(nImdb)) {
  setStatus("Missing or invalid IMDb ID. Use the bookmarklet from an IMDb title page.", true);
} else {

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      const msg = "Sign in on the watchlist first, then try again.";
      if (window.self !== window.top) {
        window.parent.postMessage({ type: "add-result", ok: false, error: msg }, "*");
      }
      if (window.opener) {
        window.opener.postMessage({ type: "add-result", ok: false, error: msg }, "*");
        setTimeout(function () { window.close(); }, 300);
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
      const body = { imdbId: nImdb, watch_region: watchRegion };
      const listMatch = document.cookie.match(/bookmarklet_list_id=([^;]+)/);
      if (listMatch) body.listId = decodeURIComponent(listMatch[1].trim());

      const res = await fetch("/.netlify/functions/add-from-imdb", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });

      const data = await res.json();

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
        setTimeout(function () { window.close(); }, 300);
      }
      if (data.ok) {
        setStatus(data.message || "Added to watchlist!");
      } else {
        setStatus(data.error || "Failed to add.", true);
      }
    } catch (err) {
      const errMsg = err.message || "Could not reach the server.";
      if (window.self !== window.top) {
        window.parent.postMessage(
          { type: "add-result", ok: false, error: errMsg },
          "*"
        );
      }
      if (window.opener) {
        window.opener.postMessage(
          { type: "add-result", ok: false, error: errMsg },
          "*"
        );
        setTimeout(function () { window.close(); }, 300);
      }
      setStatus(errMsg, true);
    }
  });
}
