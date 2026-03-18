import { auth, onAuthStateChanged } from "./firebase.js";

const params = new URLSearchParams(window.location.search);
const imdbId = params.get("imdbId") || params.get("i");

const statusEl = document.getElementById("status");
const backLink = document.getElementById("back-link");

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.style.color = isError ? "var(--error, #e74c3c)" : "var(--text)";
  backLink.style.display = "block";
}

const norm = (id) => (String(id || "").startsWith("tt") ? id : `tt${id || ""}`);
const nImdb = norm(imdbId);

if (!imdbId || !/^tt\d+$/.test(nImdb)) {
  setStatus("Missing or invalid IMDb ID. Use the bookmarklet from an IMDb title page.", true);
} else {

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      setStatus('Sign in on the watchlist first, then try again.', true);
      statusEl.innerHTML = 'Sign in on the <a href="./">watchlist</a> first, then try again.';
      return;
    }

    try {
      const token = await user.getIdToken();
      const body = { imdbId: nImdb };
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

      if (data.ok) {
        setStatus(data.message || "Added to watchlist!");
      } else {
        setStatus(data.error || "Failed to add.", true);
      }
    } catch (err) {
      setStatus(err.message || "Could not reach the server.", true);
    }
  });
}
