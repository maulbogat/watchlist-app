import {
  auth,
  signInWithPopup,
  GoogleAuthProvider,
  fbSignOut,
  onAuthStateChanged,
  movieKey,
  getMoviesCatalog,
  getWatchedList,
  addWatched,
  removeWatched,
} from "./firebase.js";

let movies = [];
let currentFilter = "both"; // 'both' | 'movie' | 'show'
let currentGenre = ""; // '' = all, or genre name
let currentStatus = "to-watch"; // 'to-watch' | 'watched'
let currentModalMovie = null; // movie currently shown in modal

function getUniqueGenres() {
  const set = new Set();
  movies.forEach((m) => {
    const g = String(m.genre || "").trim();
    if (!g) return;
    g.split(/\s*\/\s*/).forEach((s) => {
      const t = s.trim();
      if (t) set.add(t);
    });
  });
  return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

function getFilteredTitles() {
  let list = currentFilter === "both" ? movies : movies.filter((m) => m.type === currentFilter);
  if (currentGenre) {
    list = list.filter((m) => {
      const g = String(m.genre || "");
      return g.split(/\s*\/\s*/).some((s) => s.trim().toLowerCase() === currentGenre.toLowerCase());
    });
  }
  const byStatus =
    currentStatus === "watched"
      ? list.filter((m) => m.watched === true)
      : list.filter((m) => m.watched !== true);

  return [...byStatus].sort((a, b) =>
    String(a.title).localeCompare(String(b.title), undefined, { sensitivity: "base" })
  );
}

function updateHeaderMeta(visibleCount) {
  const el = document.getElementById("header-meta");
  if (!el) return;
  el.innerHTML = `${visibleCount} titles`;
}

function renderServiceChips(services, { limit } = {}) {
  const list = Array.isArray(services) ? services : [];
  const sliced = typeof limit === "number" ? list.slice(0, limit) : list;
  if (!sliced.length) return "";

  return `<span class="service-chips">${sliced
    .map((s) => {
      const key = String(s).trim().toLowerCase();
      const label = String(s).trim();
      return `<span class="service-chip" data-service="${key}">${label}</span>`;
    })
    .join("")}</span>`;
}

function buildCards() {
  const grid = document.getElementById("grid");
  grid.innerHTML = "";

  const visible = getFilteredTitles();
  updateHeaderMeta(visible.length);

  if (!visible.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent =
      currentStatus === "watched"
        ? "No watched titles yet."
        : "No titles match your filters.";
    grid.appendChild(empty);
    return;
  }

  visible.forEach((m) => {
    const card = document.createElement("div");
    card.className = "card";
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    card.setAttribute("aria-label", "Play trailer for " + m.title);

    const thumbHTML = m.thumb
      ? `<img src="${m.thumb}" alt="${m.title} trailer thumbnail" loading="lazy" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" />
         <div class="thumb-placeholder" style="display:none">${m.title}</div>`
      : `<div class="thumb-placeholder">${m.title}</div>`;

    const yearStr = m.year ? m.year : "—";
    const badgeClass = m.type === "show" ? "badge-show" : "badge-movie";
    const badgeLabel = m.type === "show" ? "TV" : "Film";
    const serviceChips = renderServiceChips(m.services, { limit: 3 });
    const serviceRow = serviceChips ? `<div class="service-row">${serviceChips}</div>` : "";
    const isWatched = m.watched === true;
    const watchedBadge = `<button type="button" class="watched-badge ${isWatched ? "watched" : ""}" aria-label="${isWatched ? "Mark as unwatched" : "Mark as watched"}" title="${isWatched ? "Mark as unwatched" : "Mark as watched"}">
      <svg viewBox="0 0 24 24" fill="${isWatched ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
    </button>`;

    card.innerHTML = `
      <div class="thumb-wrap">
        ${watchedBadge}
        ${thumbHTML}
        <div class="thumb-overlay"></div>
        <div class="play-btn">
          <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
        </div>
      </div>
      <div class="card-info">
        <div class="card-title"${/[\u0590-\u05FF]/.test(m.title) ? ' dir="rtl"' : ""}>${m.title}</div>
        <div class="card-meta">
          <span class="badge ${badgeClass}">${badgeLabel}</span>
          ${yearStr} &nbsp;·&nbsp; ${m.genre}
        </div>
        ${serviceRow}
      </div>
    `;

    card.addEventListener("click", (e) => {
      if (e.target.closest(".watched-badge")) return;
      openModal(m);
    });
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") openModal(m);
    });
    const badgeBtn = card.querySelector(".watched-badge");
    if (badgeBtn) {
      badgeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        toggleWatched(m);
      });
    }
    grid.appendChild(card);
  });
}

async function toggleWatched(m) {
  const uid = auth.currentUser?.uid;
  if (!uid) {
    alert("Sign in with Google to save your watched list across devices.");
    return;
  }
  const key = movieKey(m);
  const isWatched = m.watched === true;
  try {
    if (isWatched) {
      await removeWatched(uid, key);
      m.watched = false;
    } else {
      await addWatched(uid, key);
      m.watched = true;
    }
    buildCards();
    if (currentModalMovie && movieKey(currentModalMovie) === key) {
      const btn = document.querySelector(".modal-watched-btn");
      if (btn) {
        btn.textContent = m.watched ? "✓ Watched" : "Mark as watched";
        btn.classList.toggle("watched", m.watched);
      }
    }
  } catch (err) {
    console.error("Failed to update watched:", err);
    alert("Failed to update. Please try again.");
  }
}

function openModal(m) {
  currentModalMovie = m;
  const modal = document.getElementById("modal");
  const titleEl = document.getElementById("modal-title");
  const footer = document.getElementById("modal-footer");

  titleEl.textContent = m.title;
  titleEl.dir = /[\u0590-\u05FF]/.test(m.title) ? "rtl" : "ltr";

  if (m.youtubeId === "SEARCH") {
    const query = encodeURIComponent(m.title + " official trailer");
    const imdbUrl = m.imdbId
      ? `https://www.imdb.com/title/${m.imdbId}/`
      : null;
    const isWatched = m.watched === true;
    const trailerLink = imdbUrl
      ? `<a href="${imdbUrl}" target="_blank" style="color: var(--accent); text-decoration: none;">Watch on IMDb &#x2197;</a>`
      : `<a href="https://www.youtube.com/results?search_query=${query}" target="_blank" style="color: var(--accent); text-decoration: none;">Search on YouTube &#x2197;</a>`;
    footer.innerHTML = `
      <button type="button" class="modal-watched-btn ${isWatched ? "watched" : ""}" title="${isWatched ? "Mark as unwatched" : "Mark as watched"}">
        ${isWatched ? "✓ Watched" : "Mark as watched"}
      </button>
      <span style="opacity:0.4">·</span>
      <span>No YouTube trailer &mdash;</span>
      ${trailerLink}
    `;
    footer.querySelector(".modal-watched-btn")?.addEventListener("click", () => toggleWatched(m));
    const placeholder = modal.querySelector(".video-wrap");
    placeholder.style.background = "#0d0d10";
    placeholder.innerHTML = `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1rem;">
      <div style="font-family:var(--font-title);font-size:2rem;letter-spacing:0.06em;color:var(--muted)">${m.title}</div>
      ${imdbUrl
        ? `<a href="${imdbUrl}" target="_blank" style="font-size:0.85rem;color:var(--accent);text-decoration:none;letter-spacing:0.08em;text-transform:uppercase">Watch on IMDb &#x2197;</a>`
        : `<a href="https://www.youtube.com/results?search_query=${query}" target="_blank" style="font-size:0.85rem;color:var(--accent);text-decoration:none;letter-spacing:0.08em;text-transform:uppercase">Find Trailer on YouTube &#x2197;</a>`}
    </div>`;
  } else {
    const videoWrap = modal.querySelector(".video-wrap");
    videoWrap.style.background = "#000";
    const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(m.youtubeId)}`;
    const rawOrigin = window.location.origin;
    const originParam =
      rawOrigin && rawOrigin !== "null"
        ? `&origin=${encodeURIComponent(rawOrigin)}`
        : "";

    const serviceChips = renderServiceChips(m.services);
    const serviceInline = serviceChips
      ? ` <span style="opacity:0.4">·</span> ${serviceChips}`
      : "";

    videoWrap.innerHTML = `<iframe id="modal-iframe" allowfullscreen allow="autoplay; encrypted-media; picture-in-picture"
      referrerpolicy="strict-origin-when-cross-origin"
      src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(m.youtubeId)}?autoplay=1&rel=0&modestbranding=1&playsinline=1${originParam}"></iframe>`;

    const isWatched = m.watched === true;
    footer.innerHTML = `
      <span>${m.title}</span>
      <span style="opacity:0.4">·</span>
      <span>${m.year || ""} ${m.genre}</span>
      ${serviceInline}
      <span style="opacity:0.4">·</span>
      <button type="button" class="modal-watched-btn ${isWatched ? "watched" : ""}" data-movie-key="${movieKey(m)}" title="${isWatched ? "Mark as unwatched" : "Mark as watched"}">
        ${isWatched ? "✓ Watched" : "Mark as watched"}
      </button>
      <span style="opacity:0.4">·</span>
      <a href="${watchUrl}" target="_blank" style="color: var(--accent); text-decoration: none;">
        Watch on YouTube &#x2197;
      </a>
    `;
    footer.querySelector(".modal-watched-btn")?.addEventListener("click", () => toggleWatched(m));
  }

  modal.classList.add("open");
  document.body.style.overflow = "hidden";
}

function closeModal() {
  currentModalMovie = null;
  const modal = document.getElementById("modal");
  modal.classList.remove("open");
  const videoWrap = modal.querySelector(".video-wrap");
  videoWrap.innerHTML = `<iframe id="modal-iframe" allowfullscreen allow="autoplay; encrypted-media"></iframe>`;
  videoWrap.style.background = "#000";
  document.getElementById("modal-footer").innerHTML = "";
  document.body.style.overflow = "";
}

document.getElementById("modal-close").addEventListener("click", closeModal);
document.getElementById("modal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});

// Warn when opened from file:// since YouTube embeds often fail.
(() => {
  if (window.location.protocol !== "file:") return;
  const banner = document.getElementById("file-banner");
  const closeBtn = document.getElementById("file-banner-close");
  if (!banner || !closeBtn) return;
  banner.style.display = "flex";
  closeBtn.addEventListener("click", () => {
    banner.style.display = "none";
  });
})();

// Type filter (Both / Movies / Series)
document.querySelectorAll('input[name="typeFilter"]').forEach((input) => {
  input.addEventListener("change", (e) => {
    currentFilter = e.target.value;
    buildCards();
  });
});

// Tabs (To Watch / Watched)
document.querySelectorAll(".tab-group .tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    currentStatus = btn.dataset.status;
    document.querySelectorAll(".tab-group .tab").forEach((b) => {
      const isActive = b === btn;
      b.classList.toggle("active", isActive);
      b.setAttribute("aria-selected", isActive ? "true" : "false");
    });
    buildCards();
  });
});

// Auth UI
function updateAuthUI(user) {
  const signInBtn = document.getElementById("sign-in-btn");
  const signedIn = document.getElementById("signed-in");

  if (user) {
    signInBtn.style.display = "none";
    signedIn.style.display = "flex";
  } else {
    signInBtn.style.display = "inline-flex";
    signedIn.style.display = "none";
  }
}

document.getElementById("sign-in-btn").addEventListener("click", async () => {
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (err) {
    console.error("Sign-in error:", err);
    const msg = err.code === "auth/unauthorized-domain"
      ? "Add this domain in Firebase Console → Authentication → Settings → Authorized domains: " + window.location.hostname
      : err.message || "Sign-in failed. Please try again.";
    alert(msg);
  }
});

document.getElementById("sign-out-btn").addEventListener("click", () => {
  fbSignOut(auth);
});

// Auth state + load watched list, apply watched attribute from Firebase
function initAfterMoviesLoaded() {
  onAuthStateChanged(auth, async (user) => {
    updateAuthUI(user);
    const watchedKeys = user
      ? await getWatchedList(user.uid).catch(() => [])
      : [];
    const watchedSet = new Set(watchedKeys);
    movies.forEach((m) => {
      m.watched = watchedSet.has(movieKey(m));
    });
    buildCards();
  });
}

// Load movies from Firestore, then init auth + build
async function init() {
  const grid = document.getElementById("grid");
  grid.innerHTML = '<div class="empty-state">Loading catalog…</div>';

  try {
    movies = await getMoviesCatalog();
    if (!movies.length) {
      grid.innerHTML =
        '<div class="empty-state">No catalog found. Add movies to Firestore <code>catalog/movies</code> in Firebase Console.</div>';
      return;
    }
    initAfterMoviesLoaded();
    renderGenreFilter();
  } catch (err) {
    console.error("Failed to load catalog:", err);
    grid.innerHTML =
      '<div class="empty-state">Failed to load catalog. Check console and Firestore setup.</div>';
  }
}

function renderGenreFilter() {
  const container = document.getElementById("genre-filter-wrap");
  if (!container) return;
  const genres = getUniqueGenres();
  if (!genres.length) {
    container.style.display = "none";
    return;
  }
  container.style.display = "flex";
  container.innerHTML = `
    <label for="genre-filter" class="genre-filter-label">Genre</label>
    <select id="genre-filter" class="genre-filter-select" aria-label="Filter by genre">
      <option value="">All</option>
      ${genres.map((g) => `<option value="${g}">${g}</option>`).join("")}
    </select>
  `;
  container.querySelector("#genre-filter").addEventListener("change", (e) => {
    currentGenre = e.target.value;
    buildCards();
  });
}

init();

