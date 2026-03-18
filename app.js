import {
  auth,
  signInWithPopup,
  GoogleAuthProvider,
  fbSignOut,
  onAuthStateChanged,
  movieKey,
  getMoviesCatalog,
  getStatusData,
  setStatus,
  removeTitle,
} from "./firebase.js";

const STATUS_ORDER = ["to-watch", "maybe-later", "watched", "archive"];

const GENRE_LIMIT = 10;

let movies = [];
let currentFilter = "both"; // 'both' | 'movie' | 'show'
let currentGenre = ""; // '' = all, or genre name
let currentStatus = "to-watch"; // 'to-watch' | 'maybe-later' | 'watched' | 'archive'
let currentModalMovie = null; // movie currently shown in modal

function getUniqueGenres() {
  const count = new Map();
  movies.forEach((m) => {
    const g = String(m.genre || "").trim();
    if (!g) return;
    g.split(/\s*\/\s*/).forEach((s) => {
      const t = s.trim();
      if (t) count.set(t, (count.get(t) || 0) + 1);
    });
  });
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], undefined, { sensitivity: "base" }))
    .slice(0, GENRE_LIMIT)
    .map(([name]) => name);
}

function getFilteredTitles() {
  let list = currentFilter === "both" ? movies : movies.filter((m) => m.type === currentFilter);
  list = list.filter((m) => !m.removed && (m.status || "to-watch") === currentStatus);
  if (currentGenre) {
    list = list.filter((m) => {
      const g = String(m.genre || "");
      return g.split(/\s*\/\s*/).some((s) => s.trim().toLowerCase() === currentGenre.toLowerCase());
    });
  }

  return [...list].sort((a, b) =>
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
    const messages = {
      "to-watch": "No titles to watch yet.",
      "maybe-later": "No titles in Maybe later.",
      watched: "No watched titles yet.",
      archive: "No archived titles.",
    };
    empty.textContent = messages[currentStatus] || "No titles match your filters.";
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
    const s = m.status || "to-watch";
    const statusLabels = { "to-watch": "To Watch", "maybe-later": "Maybe later", watched: "Watched", archive: "Archive" };
    const statusIcons = {
      "to-watch": '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/>',
      "maybe-later": '<path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/>',
      watched: '<path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>',
      archive: '<path d="M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5z"/>',
    };
    const statusBadge = `<div class="status-badge-wrap">
      <button type="button" class="status-badge status-${s}" aria-label="Move to status" title="Move to…" data-status="${s}" aria-haspopup="true" aria-expanded="false">
        <svg viewBox="0 0 24 24" fill="${s === "watched" ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2">${statusIcons[s]}</svg>
      </button>
      <div class="status-dropdown" role="menu" aria-label="Move to">
        ${STATUS_ORDER.map((st) => `<button type="button" class="status-dropdown-item ${st === s ? "active" : ""}" role="menuitem" data-status="${st}">${statusLabels[st]}</button>`).join("")}
      </div>
    </div>`;
    const deleteBtn = `<button type="button" class="card-delete-btn" aria-label="Remove from list" title="Remove">&#215;</button>`;

    card.innerHTML = `
      <div class="thumb-wrap">
        ${deleteBtn}
        ${statusBadge}
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
      if (e.target.closest(".status-badge-wrap") || e.target.closest(".card-delete-btn")) return;
      openModal(m);
    });
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") openModal(m);
    });
    const badgeBtn = card.querySelector(".status-badge");
    const dropdown = card.querySelector(".status-dropdown");
    const deleteBtnEl = card.querySelector(".card-delete-btn");
    if (deleteBtnEl) {
      deleteBtnEl.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        removeFromCard(m);
      });
    }
    if (badgeBtn && dropdown) {
      badgeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        closeAllStatusDropdowns();
        dropdown.classList.toggle("open", !dropdown.classList.contains("open"));
        badgeBtn.setAttribute("aria-expanded", dropdown.classList.contains("open"));
      });
      dropdown.querySelectorAll(".status-dropdown-item").forEach((item) => {
        item.addEventListener("click", (e) => {
          e.stopPropagation();
          const status = item.dataset.status;
          if (status && status !== (m.status || "to-watch")) setStatusFromCard(m, status);
          dropdown.classList.remove("open");
          badgeBtn.setAttribute("aria-expanded", "false");
        });
      });
    }
    grid.appendChild(card);
  });
}

function closeAllStatusDropdowns() {
  document.querySelectorAll(".status-dropdown.open").forEach((d) => d.classList.remove("open"));
  document.querySelectorAll(".status-badge[aria-expanded='true']").forEach((b) => b.setAttribute("aria-expanded", "false"));
}

async function setStatusFromCard(m, status) {
  const uid = auth.currentUser?.uid;
  if (!uid) {
    alert("Sign in with Google to save your status across devices.");
    return;
  }
  const key = movieKey(m);
  try {
    await setStatus(uid, key, status);
    m.status = status;
    buildCards();
    updateModalStatusBtn();
  } catch (err) {
    console.error("Failed to update status:", err);
    alert("Failed to update. Please try again.");
  }
}

async function removeFromCard(m) {
  const uid = auth.currentUser?.uid;
  if (!uid) {
    alert("Sign in with Google to save your status across devices.");
    return;
  }
  const key = movieKey(m);
  try {
    await removeTitle(uid, key);
    m.removed = true;
    buildCards();
    closeModal();
  } catch (err) {
    console.error("Failed to remove:", err);
    alert("Failed to remove. Please try again.");
  }
}

function renderModalStatusBtns(m) {
  const s = m.status || "to-watch";
  const labels = { "to-watch": "To Watch", "maybe-later": "Maybe later", watched: "Watched", archive: "Archive" };
  return STATUS_ORDER.map(
    (status) =>
      `<button type="button" class="modal-status-btn ${status === s ? "active" : ""}" data-status="${status}" title="${labels[status]}">${labels[status]}</button>`
  ).join("");
}

function updateModalStatusBtn() {
  if (!currentModalMovie) return;
  const btns = document.querySelectorAll(".modal-status-btn");
  btns.forEach((btn) => {
    const s = btn.dataset.status;
    btn.classList.toggle("active", (currentModalMovie.status || "to-watch") === s);
  });
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
    const trailerLink = imdbUrl
      ? `<a href="${imdbUrl}" target="_blank" style="color: var(--accent); text-decoration: none;">Watch on IMDb &#x2197;</a>`
      : `<a href="https://www.youtube.com/results?search_query=${query}" target="_blank" style="color: var(--accent); text-decoration: none;">Search on YouTube &#x2197;</a>`;
    footer.innerHTML = `
      <span class="modal-status-btns">${renderModalStatusBtns(m)}</span>
      <span style="opacity:0.4">·</span>
      <span>No YouTube trailer &mdash;</span>
      ${trailerLink}
    `;
    footer.querySelectorAll(".modal-status-btn").forEach((btn) => {
      btn.addEventListener("click", () => setStatusFromCard(m, btn.dataset.status));
    });
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

    footer.innerHTML = `
      <span>${m.title}</span>
      <span style="opacity:0.4">·</span>
      <span>${m.year || ""} ${m.genre}</span>
      ${serviceInline}
      <span style="opacity:0.4">·</span>
      <span class="modal-status-btns">${renderModalStatusBtns(m)}</span>
      <span style="opacity:0.4">·</span>
      <a href="${watchUrl}" target="_blank" style="color: var(--accent); text-decoration: none;">
        Watch on YouTube &#x2197;
      </a>
    `;
    footer.querySelectorAll(".modal-status-btn").forEach((btn) => {
      btn.addEventListener("click", () => setStatusFromCard(m, btn.dataset.status));
    });
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
document.addEventListener("click", (e) => {
  if (!e.target.closest(".status-badge-wrap")) closeAllStatusDropdowns();
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

async function setBookmarkletCookie(user) {
  if (window.location.protocol !== "https:") return;
  try {
    if (!user) {
      document.cookie = "bookmarklet_token=; path=/; max-age=0";
      return;
    }
    const token = await user.getIdToken();
    document.cookie = `bookmarklet_token=${token}; path=/; max-age=2592000; SameSite=None; Secure`;
  } catch (e) {
    console.warn("Bookmarklet cookie:", e);
  }
}

// Auth state + load status data, apply status attribute from Firebase
function initAfterMoviesLoaded() {
  onAuthStateChanged(auth, async (user) => {
    updateAuthUI(user);
    setBookmarkletCookie(user);
    let data = { watched: [], maybeLater: [], archive: [] };
    if (user) {
      try {
        data = await getStatusData(user.uid);
      } catch (e) {
        console.warn("Failed to load status data:", e);
      }
    }
    const watchedSet = new Set(data.watched);
    const maybeLaterSet = new Set(data.maybeLater);
    const archiveSet = new Set(data.archive);
    const removedSet = new Set(data.removed || []);
    movies.forEach((m) => {
      const key = movieKey(m);
      m.removed = removedSet.has(key);
      if (watchedSet.has(key)) m.status = "watched";
      else if (maybeLaterSet.has(key)) m.status = "maybe-later";
      else if (archiveSet.has(key)) m.status = "archive";
      else m.status = "to-watch";
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
    <button type="button" class="genre-chip ${!currentGenre ? "active" : ""}" data-genre="" aria-pressed="${!currentGenre}">All</button>
    ${genres.map((g) => `<button type="button" class="genre-chip ${currentGenre === g ? "active" : ""}" data-genre="${g}" aria-pressed="${currentGenre === g}">${g}</button>`).join("")}
  `;
  container.querySelectorAll(".genre-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentGenre = btn.dataset.genre || "";
      container.querySelectorAll(".genre-chip").forEach((b) => {
        const isActive = (b.dataset.genre || "") === currentGenre;
        b.classList.toggle("active", isActive);
        b.setAttribute("aria-pressed", isActive);
      });
      buildCards();
    });
  });
}

init();

