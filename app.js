import {
  auth,
  signInWithPopup,
  GoogleAuthProvider,
  fbSignOut,
  onAuthStateChanged,
  movieKey,
  getUserMovies,
  setStatus,
  removeTitle,
  createSharedList,
  getSharedList,
  getSharedListsForUser,
  getSharedListMovies,
  setSharedListStatus,
  removeFromSharedList,
  addToSharedList,
  addToPersonalList,
  leaveSharedList,
  createPersonalList,
  getPersonalLists,
  getPersonalListMovies,
  setPersonalListStatus,
  removeFromPersonalList,
  renamePersonalList,
  deletePersonalList,
  renameSharedList,
  deleteSharedList,
  moveItemFromSharedToPersonal,
  moveItemFromPersonalToShared,
  updateMovieMetadata,
  getUserProfile,
  setUserCountry,
} from "./firebase.js";
import { COUNTRIES, countryCodeToFlag } from "./countries.js";

const STATUS_ORDER = ["to-watch", "watched"];

const GENRE_LIMIT = 10;

// Version footer: visible only when signed in as this email (bump version on deploy)
const DEBUG_EMAIL = "maulbogat@gmail.com";
const APP_VERSION = "92dea52";

let movies = [];
let currentFilter = "both"; // 'both' | 'movie' | 'show'
let currentGenre = ""; // '' = all, or genre name
let currentStatus = "to-watch"; // 'to-watch' | 'watched'
let currentModalMovie = null; // movie currently shown in modal
let currentListMode = "personal"; // "personal" | { type: "personal", listId, name } | { type: "shared", listId, name }
let sharedLists = [];
let personalLists = [];

/** User's selected country code (e.g. 'IL') for TMDB watch provider API. Set from Firestore profile. */
let userCountryCode = "IL";

function getListFromUrl() {
  const list = new URLSearchParams(window.location.search).get("list");
  return list || null;
}

function saveLastList(user, mode) {
  const val = mode === "personal" ? "personal"
    : (typeof mode === "object" && mode?.listId) ? mode.listId : "personal";
  try {
    if (user) localStorage.setItem(`watchlist_lastList_${user.uid}`, val);
  } catch (e) {}
  const url = new URL(window.location.href);
  url.searchParams.delete("join");
  if (val === "personal") {
    url.searchParams.delete("list");
  } else {
    url.searchParams.set("list", val);
  }
  window.history.replaceState({}, "", url.pathname + (url.search || ""));
}

function getLastList(user) {
  const fromUrl = getListFromUrl();
  if (fromUrl) return fromUrl;
  if (!user) return null;
  try {
    return localStorage.getItem(`watchlist_lastList_${user.uid}`) || null;
  } catch (e) {
    return null;
  }
}

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
  if (currentStatus === "recently-added") {
    // Last 10 items added to catalog (by array order)
    const recent = [];
    for (let i = movies.length - 1; i >= 0 && recent.length < 10; i--) {
      const m = movies[i];
      if (currentFilter !== "both" && m.type !== currentFilter) continue;
      if (currentGenre) {
        const g = String(m.genre || "");
        if (!g.split(/\s*\/\s*/).some((s) => s.trim().toLowerCase() === currentGenre.toLowerCase())) continue;
      }
      recent.push(m);
    }
    return recent;
  }

  let list = currentFilter === "both" ? movies : movies.filter((m) => m.type === currentFilter);
  list = list.filter((m) => {
    const s = m.status || "to-watch";
    if (currentStatus === "to-watch") return s === "to-watch" || s === "maybe-later" || s === "archive";
    return s === currentStatus;
  });
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

function updateFilterCount(visibleCount) {
  const el = document.getElementById("filter-count");
  if (!el) return;
  el.textContent = typeof visibleCount === "number" ? `${visibleCount} title${visibleCount === 1 ? "" : "s"}` : "";
}

function updateHeaderTitle() {
  const el = document.getElementById("header-title");
  if (!el) return;
  el.textContent = "My";
}

/** Watch-provider names for TMDB region: prefers servicesByRegion[country], then legacy services. */
function servicesForMovie(m, countryCode) {
  const code = (countryCode || "IL").toString().toUpperCase().slice(0, 2);
  const map = m.servicesByRegion;
  if (map && typeof map === "object" && Array.isArray(map[code])) {
    return map[code];
  }
  return Array.isArray(m.services) ? m.services : [];
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
  updateFilterCount(visible.length);

  if (!visible.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const messages = {
      "recently-added": "No recently added titles.",
      "to-watch": "No titles to watch yet.",
      watched: "No watched titles yet.",
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
    const serviceChips = renderServiceChips(servicesForMovie(m, userCountryCode), { limit: 3 });
    const serviceRow = serviceChips ? `<div class="service-row">${serviceChips}</div>` : "";
    const s = m.status || "to-watch";
    const displayStatus = s === "maybe-later" || s === "archive" ? "to-watch" : s;
    const statusLabels = { "to-watch": "To Watch", watched: "Watched" };
    const statusIcons = {
      "to-watch": '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" fill="none"/><circle cx="12" cy="12" r="3" fill="none"/>',
      watched: '<path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>',
    };
    const statusBadge = `<div class="status-badge-wrap">
      <button type="button" class="status-badge status-${displayStatus}" aria-label="Change status" title="Change status" data-status="${displayStatus}" aria-haspopup="true" aria-expanded="false">
        <svg viewBox="0 0 24 24" fill="${displayStatus === "watched" ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2">${statusIcons[displayStatus]}</svg>
      </button>
      <div class="status-dropdown" role="menu" aria-label="Move to">
        ${STATUS_ORDER.map((st) => `<button type="button" class="status-dropdown-item ${st === displayStatus ? "active" : ""}" role="menuitem" data-status="${st}">${statusLabels[st]}</button>`).join("")}
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
        const uid = auth.currentUser?.uid;
        if (!uid) {
          alert("Sign in with Google to save your status across devices.");
          return;
        }
        showRemoveToast(m, () => {}, () => removeFromCard(m));
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
          const current = m.status === "maybe-later" || m.status === "archive" ? "to-watch" : (m.status || "to-watch");
          if (status && status !== current) setStatusFromCard(m, status);
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
    if (typeof currentListMode === "object" && currentListMode?.type === "shared") {
      await setSharedListStatus(currentListMode.listId, key, status);
    } else if (typeof currentListMode === "object" && currentListMode?.type === "personal") {
      await setPersonalListStatus(uid, currentListMode.listId, key, status);
    } else {
      await setStatus(uid, key, status);
    }
    m.status = status;
    buildCards();
    updateModalStatusBtn();
  } catch (err) {
    console.error("Failed to update status:", err);
    alert("Failed to update. Please try again.");
  }
}

function showRemoveToast(m, onUndo, onRemove) {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = "toast";
  const title = escapeHtml(String(m.title || "").trim() || "Title");
  toast.innerHTML = `<span>Removed ${title}</span><button type="button" class="toast-undo-btn">Undo</button>`;
  container.appendChild(toast);
  let removed = false;
  const doRemove = () => {
    if (removed) return;
    removed = true;
    if (toast.parentNode) toast.remove();
    onRemove();
  };
  const undo = () => {
    if (removed) return;
    removed = true;
    if (toast.parentNode) toast.remove();
    onUndo();
  };
  const timer = setTimeout(doRemove, 4000);
  toast.querySelector(".toast-undo-btn").addEventListener("click", () => {
    clearTimeout(timer);
    undo();
  });
}

async function removeFromCard(m) {
  const uid = auth.currentUser?.uid;
  if (!uid) {
    alert("Sign in with Google to save your status across devices.");
    return;
  }
  const key = movieKey(m);
  try {
    if (typeof currentListMode === "object" && currentListMode?.type === "shared") {
      await removeFromSharedList(currentListMode.listId, key);
    } else if (typeof currentListMode === "object" && currentListMode?.type === "personal") {
      await removeFromPersonalList(uid, currentListMode.listId, key);
    } else {
      await removeTitle(uid, key);
    }
    movies = movies.filter((x) => movieKey(x) !== key);
    buildCards();
    closeModal();
  } catch (err) {
    console.error("Failed to remove:", err);
    alert("Failed to remove. Please try again.");
  }
}

const STATUS_LABELS = { "to-watch": "To Watch", watched: "Watched" };
const CHECK_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';

function renderModalFooter(m, youtubeLinkHtml) {
  const s = m.status === "maybe-later" || m.status === "archive" ? "to-watch" : (m.status || "to-watch");
  const currentListLabel = getCurrentListLabel();
  const serviceChips = renderServiceChips(servicesForMovie(m, userCountryCode));
  const servicePart = serviceChips ? ` <span style="opacity:0.4">·</span> ${serviceChips}` : "";
  const metaParts = [m.year || "", m.genre || ""].filter(Boolean).join(" ");
  return `
    <div class="modal-footer-meta">${metaParts}${servicePart}</div>
    <div class="modal-footer-actions">
      <div class="modal-action-dropdown" data-dropdown="status">
        <button type="button" class="modal-action-btn modal-status-trigger" aria-haspopup="true" aria-expanded="false">
          <span class="modal-action-label">${STATUS_LABELS[s]}</span>
        </button>
        <div class="modal-action-dropdown-panel" role="menu">
          ${STATUS_ORDER.map((st) => `<button type="button" class="modal-action-dropdown-item" role="menuitem" data-status="${st}">${STATUS_LABELS[st]}${st === s ? " " + CHECK_SVG : ""}</button>`).join("")}
        </div>
      </div>
      <div class="modal-action-dropdown" data-dropdown="add-to-list">
        <button type="button" class="modal-action-btn modal-add-to-list-trigger" aria-haspopup="true" aria-expanded="false">
          <span class="modal-action-label modal-list-label">${escapeHtml(currentListLabel)}</span>
        </button>
        <div class="modal-action-dropdown-panel modal-add-to-list-panel" role="menu"></div>
      </div>
      ${youtubeLinkHtml}
    </div>
  `;
}

function updateModalStatusBtn() {
  if (!currentModalMovie) return;
  const trigger = document.querySelector(".modal-status-trigger");
  const displayStatus = currentModalMovie.status === "maybe-later" || currentModalMovie.status === "archive" ? "to-watch" : (currentModalMovie.status || "to-watch");
  if (trigger) trigger.querySelector(".modal-action-label").textContent = STATUS_LABELS[displayStatus];
  document.querySelectorAll(".modal-action-dropdown-item[data-status]").forEach((btn) => {
    const isActive = btn.dataset.status === displayStatus;
    btn.innerHTML = STATUS_LABELS[btn.dataset.status] + (isActive ? " " + CHECK_SVG : "");
  });
}

function updateModalListBtn() {
  const labelEl = document.querySelector(".modal-add-to-list-trigger .modal-list-label");
  if (labelEl) labelEl.textContent = getCurrentListLabel();
}

async function getListsContainingMovie(m) {
  const user = auth.currentUser;
  if (!user) return new Set();
  const key = movieKey(m);
  const containing = new Set();
  for (const l of personalLists) {
    const listId = l.id;
    try {
      const listMovies = await getPersonalListMovies(user.uid, listId);
      if (listMovies.some((x) => movieKey(x) === key)) containing.add(listId);
    } catch (_) {}
  }
  for (const l of sharedLists) {
    const items = Array.isArray(l.items) ? l.items : [];
    if (items.some((x) => movieKey(x) === key)) containing.add(l.id);
  }
  return containing;
}

function attachModalFooterHandlers(footer, m) {
  const statusDropdown = footer.querySelector("[data-dropdown='status']");
  const statusTrigger = footer.querySelector(".modal-status-trigger");
  const statusPanel = statusDropdown?.querySelector(".modal-action-dropdown-panel");
  if (statusTrigger && statusPanel) {
    statusTrigger.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = statusPanel.classList.contains("open");
      footer.querySelectorAll(".modal-action-dropdown-panel.open").forEach((p) => p.classList.remove("open"));
      footer.querySelectorAll(".modal-action-btn[aria-expanded='true']").forEach((b) => b.setAttribute("aria-expanded", "false"));
      if (!open) {
        statusPanel.classList.add("open");
        statusTrigger.setAttribute("aria-expanded", "true");
      }
    });
    statusPanel.querySelectorAll("[data-status]").forEach((item) => {
      item.addEventListener("click", async (e) => {
        e.stopPropagation();
        const status = item.dataset.status;
        const current = m.status === "maybe-later" || m.status === "archive" ? "to-watch" : (m.status || "to-watch");
        if (status && status !== current) await setStatusFromCard(m, status);
        statusPanel.classList.remove("open");
        statusTrigger.setAttribute("aria-expanded", "false");
      });
    });
  }

  const addDropdown = footer.querySelector("[data-dropdown='add-to-list']");
  const addTrigger = footer.querySelector(".modal-add-to-list-trigger");
  const addPanel = footer.querySelector(".modal-add-to-list-panel");
  if (addTrigger && addPanel) {
    addTrigger.addEventListener("click", async (e) => {
      e.stopPropagation();
      const open = addPanel.classList.contains("open");
      footer.querySelectorAll(".modal-action-dropdown-panel.open").forEach((p) => p.classList.remove("open"));
      footer.querySelectorAll(".modal-action-btn[aria-expanded='true']").forEach((b) => b.setAttribute("aria-expanded", "false"));
      if (!open) {
        addPanel.innerHTML = '<span class="modal-add-to-list-loading">Loading…</span>';
        addPanel.classList.add("open");
        addTrigger.setAttribute("aria-expanded", "true");
        const containing = await getListsContainingMovie(m);
        const user = auth.currentUser;
        if (!user) {
          addPanel.innerHTML = '<span class="modal-add-to-list-empty">Sign in to manage lists</span>';
          return;
        }
        const items = [];
        for (const l of personalLists) {
          const inList = containing.has(l.id);
          const name = escapeHtml(l.name || "My list");
          items.push(`<button type="button" class="modal-action-dropdown-item" role="menuitem" data-type="personal" data-list-id="${l.id}" data-list-name="${name}" data-in-list="${inList}">${name}${inList ? " " + CHECK_SVG : ""}</button>`);
        }
        for (const l of sharedLists) {
          const inList = containing.has(l.id);
          const name = escapeHtml(l.name || "Shared list");
          items.push(`<button type="button" class="modal-action-dropdown-item" role="menuitem" data-type="shared" data-list-id="${l.id}" data-list-name="${name}" data-in-list="${inList}">${name}${inList ? " " + CHECK_SVG : ""}</button>`);
        }
        addPanel.innerHTML = items.length ? items.join("") : '<span class="modal-add-to-list-empty">No lists</span>';
        addPanel.querySelectorAll(".modal-action-dropdown-item[data-list-id]").forEach((item) => {
          item.addEventListener("click", async (e) => {
            e.stopPropagation();
            const type = item.dataset.type;
            const listId = item.dataset.listId;
            const listName = item.dataset.listName || "";
            const inList = item.dataset.inList === "true";
            try {
              if (inList) {
                if (type === "personal") await removeFromPersonalList(user.uid, listId, movieKey(m));
                else await removeFromSharedList(listId, movieKey(m));
                item.dataset.inList = "false";
                item.innerHTML = listName;
              } else {
                if (type === "personal") await addToPersonalList(user.uid, listId, m);
                else await addToSharedList(listId, m);
                item.dataset.inList = "true";
                item.innerHTML = listName + " " + CHECK_SVG;
              }
              if (typeof currentListMode === "object" && currentListMode?.listId === listId) {
                movies = type === "personal" ? await getPersonalListMovies(user.uid, listId) : await getSharedListMovies(listId);
                buildCards();
              }
            } catch (err) {
              console.error(err);
              alert(err.message || "Failed to update list.");
            }
          });
        });
      }
    });
  }

  document.addEventListener("click", function closeModalDropdowns(ev) {
    if (!footer.contains(ev.target)) {
      footer.querySelectorAll(".modal-action-dropdown-panel.open").forEach((p) => p.classList.remove("open"));
      footer.querySelectorAll(".modal-action-btn[aria-expanded='true']").forEach((b) => b.setAttribute("aria-expanded", "false"));
      document.removeEventListener("click", closeModalDropdowns);
    }
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
    const imdbUrl = m.imdbId ? `https://www.imdb.com/title/${m.imdbId}/` : null;
    const trailerLink = imdbUrl
      ? `<a href="${imdbUrl}" target="_blank" class="modal-action-btn modal-youtube-link">Watch on IMDb &#x2197;</a>`
      : `<a href="https://www.youtube.com/results?search_query=${query}" target="_blank" class="modal-action-btn modal-youtube-link">Search on YouTube &#x2197;</a>`;
    footer.innerHTML = renderModalFooter(m, trailerLink);
    attachModalFooterHandlers(footer, m);
    const placeholder = modal.querySelector(".video-wrap");
    placeholder.style.background = "#0d0d10";
    placeholder.innerHTML = `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1rem;">
      <div style="font-family:var(--font-title);font-size:2rem;letter-spacing:0.06em;color:var(--muted)">${m.title}</div>
      <div class="trailer-loading" style="font-size:0.9rem;color:var(--muted)">Loading trailer…</div>
    </div>`;

    const apiBase = window.location.origin;
    const watchRegion = userCountryCode ? `&watch_region=${encodeURIComponent(userCountryCode)}` : "";
    const fetchUrl = m.imdbId
      ? `${apiBase}/.netlify/functions/add-from-imdb?imdbId=${encodeURIComponent(m.imdbId)}${watchRegion}`
      : `${apiBase}/.netlify/functions/add-from-imdb?title=${encodeURIComponent(m.title)}${m.year ? "&year=" + encodeURIComponent(m.year) : ""}${watchRegion}`;

    fetch(fetchUrl)
      .then(async (r) => {
        let data = {};
        try {
          data = await r.json();
        } catch {
          data = {};
        }
        if (!r.ok) data = { ...data, ok: false };
        return data;
      })
      .then((data) => {
        if (currentModalMovie !== m) return;
        const foundTrailer = data.ok && (data.youtubeId || data.embedUrl);
        const foundThumb = data.thumb; // may come from 404 response (OMDb poster)
        const updates = {};
        if (foundThumb && !m.thumb) {
          m.thumb = data.thumb;
          updates.thumb = data.thumb;
        }
        if (foundTrailer && data.youtubeId) {
          m.youtubeId = data.youtubeId;
          if (!m.thumb) {
            m.thumb = `https://img.youtube.com/vi/${data.youtubeId}/hqdefault.jpg`;
            updates.thumb = m.thumb;
          }
          updates.youtubeId = data.youtubeId;
        }
        if (Array.isArray(data.services) && data.services.length > 0) {
          if (!m.servicesByRegion) m.servicesByRegion = {};
          m.servicesByRegion[userCountryCode] = data.services;
          m.services = data.services;
          updates.services = data.services;
        }
        if (Object.keys(updates).length) {
          buildCards();
          const user = auth.currentUser;
          if (user) {
            updateMovieMetadata(user.uid, currentListMode, movieKey(m), updates, userCountryCode).catch(() => {});
          }
        }
        if (foundTrailer) {
          placeholder.style.background = "#000";
          if (data.youtubeId) {
            const rawOrigin = window.location.origin;
            const originParam = rawOrigin && rawOrigin !== "null" ? `&origin=${encodeURIComponent(rawOrigin)}` : "";
            placeholder.innerHTML = `<iframe id="modal-iframe" allowfullscreen allow="autoplay; encrypted-media; picture-in-picture"
              referrerpolicy="strict-origin-when-cross-origin"
              src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(data.youtubeId)}?autoplay=1&rel=0&modestbranding=1&playsinline=1${originParam}"></iframe>`;
          } else if (data.embedUrl) {
            // IMDb blocks embedding this player on third-party sites (X-Frame-Options / CSP).
            const safeEmbed = String(data.embedUrl).replace(/"/g, "&quot;");
            placeholder.innerHTML = `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1.25rem;padding:1.5rem;text-align:center;background:#0d0d10;">
              <div style="font-family:var(--font-title);font-size:1.35rem;letter-spacing:0.06em;color:var(--text);max-width:22rem">${escapeHtml(m.title)}</div>
              <p style="font-size:0.85rem;color:var(--muted);margin:0;max-width:24rem;line-height:1.45">IMDb doesn’t allow playing this trailer inside other sites. Open it on IMDb in a new tab.</p>
              <a href="${safeEmbed}" target="_blank" rel="noopener noreferrer" class="modal-action-btn modal-youtube-link" style="display:inline-flex">Play trailer on IMDb &#x2197;</a>
            </div>`;
          }
        } else {
          placeholder.style.background = "#0d0d10";
          placeholder.innerHTML = `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1rem;">
            <div style="font-family:var(--font-title);font-size:2rem;letter-spacing:0.06em;color:var(--muted)">${m.title}</div>
            ${imdbUrl ? `<a href="${imdbUrl}" target="_blank" style="font-size:0.85rem;color:var(--accent);text-decoration:none;letter-spacing:0.08em;text-transform:uppercase">Watch on IMDb &#x2197;</a>` : ""}
            <a href="https://www.youtube.com/results?search_query=${query}" target="_blank" style="font-size:0.85rem;color:var(--accent);text-decoration:none;letter-spacing:0.08em;text-transform:uppercase">Search on YouTube &#x2197;</a>
          </div>`;
        }
      })
      .catch(() => {
        if (currentModalMovie === m) {
          placeholder.innerHTML = `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1rem;">
            <div style="font-family:var(--font-title);font-size:2rem;letter-spacing:0.06em;color:var(--muted)">${m.title}</div>
            ${imdbUrl ? `<a href="${imdbUrl}" target="_blank" style="font-size:0.85rem;color:var(--accent);text-decoration:none;letter-spacing:0.08em;text-transform:uppercase">Watch on IMDb &#x2197;</a>` : ""}
            <a href="https://www.youtube.com/results?search_query=${query}" target="_blank" style="font-size:0.85rem;color:var(--accent);text-decoration:none;letter-spacing:0.08em;text-transform:uppercase">Search on YouTube &#x2197;</a>
          </div>`;
        }
      });
  } else {
    const videoWrap = modal.querySelector(".video-wrap");
    videoWrap.style.background = "#000";
    const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(m.youtubeId)}`;
    const rawOrigin = window.location.origin;
    const originParam =
      rawOrigin && rawOrigin !== "null"
        ? `&origin=${encodeURIComponent(rawOrigin)}`
        : "";

    videoWrap.innerHTML = `<iframe id="modal-iframe" allowfullscreen allow="autoplay; encrypted-media; picture-in-picture"
      referrerpolicy="strict-origin-when-cross-origin"
      src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(m.youtubeId)}?autoplay=1&rel=0&modestbranding=1&playsinline=1${originParam}"></iframe>`;

    const youtubeLink = `<a href="${watchUrl}" target="_blank" class="modal-action-btn modal-youtube-link">Watch on YouTube &#x2197;</a>`;
    footer.innerHTML = renderModalFooter(m, youtubeLink);
    attachModalFooterHandlers(footer, m);
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
  const avatarImg = document.getElementById("auth-avatar-img");
  const avatarInitial = document.getElementById("auth-avatar-initial");
  const avatarBtn = document.getElementById("auth-avatar-btn");
  const versionFooter = document.getElementById("version-footer");

  if (user) {
    signInBtn.style.display = "none";
    signedIn.style.display = "flex";
    if (avatarBtn) avatarBtn.title = "Signed in as " + (user.email || user.displayName || "you");
    const initial = (user.displayName || user.email || "?").charAt(0).toUpperCase();
    if (avatarInitial) avatarInitial.textContent = initial;
    if (user.photoURL && avatarImg && avatarInitial) {
      avatarImg.alt = user.displayName || user.email || "Avatar";
      avatarImg.onerror = () => {
        avatarImg.style.display = "none";
        avatarImg.src = "";
        avatarImg.onerror = null;
        avatarInitial.style.display = "";
      };
      avatarImg.src = user.photoURL;
      avatarImg.style.display = "";
      avatarInitial.style.display = "none";
    } else if (avatarInitial && avatarImg) {
      avatarInitial.style.display = "";
      avatarImg.style.display = "none";
      avatarImg.src = "";
      avatarImg.onerror = null;
    }
    if (versionFooter && user.email === DEBUG_EMAIL) {
      versionFooter.textContent = "v" + APP_VERSION;
      versionFooter.style.display = "block";
      versionFooter.setAttribute("aria-hidden", "false");
    } else if (versionFooter) {
      versionFooter.style.display = "none";
      versionFooter.setAttribute("aria-hidden", "true");
    }
  } else {
    signInBtn.style.display = "inline-flex";
    signedIn.style.display = "none";
    if (avatarInitial) avatarInitial.textContent = "";
    if (versionFooter) {
      versionFooter.style.display = "none";
      versionFooter.setAttribute("aria-hidden", "true");
    }
  }
}

document.getElementById("sign-in-btn").addEventListener("click", async () => {
  try {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    await signInWithPopup(auth, provider);
  } catch (err) {
    console.error("Sign-in error:", err);
    const msg = err.code === "auth/unauthorized-domain"
      ? "Add this domain in Firebase Console → Authentication → Settings → Authorized domains: " + window.location.hostname
      : err.message || "Sign-in failed. Please try again.";
    alert(msg);
  }
});

// Auth avatar dropdown
const authAvatarWrap = document.getElementById("signed-in");
const authAvatarBtn = document.getElementById("auth-avatar-btn");
const authDropdown = document.getElementById("auth-dropdown");
if (authAvatarBtn && authDropdown) {
  authAvatarBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = authDropdown.getAttribute("aria-hidden") === "false";
    authAvatarBtn.setAttribute("aria-expanded", !open);
    authDropdown.setAttribute("aria-hidden", open);
  });
  document.addEventListener("click", (e) => {
    if (authAvatarWrap && !authAvatarWrap.contains(e.target)) {
      authAvatarBtn?.setAttribute("aria-expanded", "false");
      authDropdown?.setAttribute("aria-hidden", "true");
    }
  });
}
document.getElementById("auth-signout-btn")?.addEventListener("click", () => {
  authDropdown?.setAttribute("aria-hidden", "true");
  authAvatarBtn?.setAttribute("aria-expanded", "false");
  fbSignOut(auth);
});
document.getElementById("auth-country-btn")?.addEventListener("click", async () => {
  authDropdown?.setAttribute("aria-hidden", "true");
  authAvatarBtn?.setAttribute("aria-expanded", "false");
  const user = auth.currentUser;
  if (!user) return;
  await showCountryModal({
    initialCode: userCountryCode,
    onSave: async (code, name) => {
      await setUserCountry(user.uid, code, name);
      userCountryCode = code;
      updateCountryDropdownRow();
    },
  });
});
document.getElementById("auth-switch-btn")?.addEventListener("click", async () => {
  authDropdown?.setAttribute("aria-hidden", "true");
  authAvatarBtn?.setAttribute("aria-expanded", "false");
  await fbSignOut(auth);
  try {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    await signInWithPopup(auth, provider);
  } catch (err) {
    if (err.code !== "auth/cancelled-popup-request" && err.code !== "auth/popup-closed-by-user") {
      console.error("Switch account error:", err);
      alert(err.message || "Failed to switch account.");
    }
  }
});

async function setBookmarkletCookie(user) {
  if (window.location.protocol !== "https:") return;
  try {
    if (!user) {
      document.cookie = "bookmarklet_token=; path=/; max-age=0";
      document.cookie = "bookmarklet_list_id=; path=/; max-age=0";
      return;
    }
    const token = await user.getIdToken();
    document.cookie = `bookmarklet_token=${token}; path=/; max-age=2592000; SameSite=None; Secure`;
    if (typeof currentListMode === "object" && currentListMode?.type === "shared") {
      document.cookie = `bookmarklet_list_id=${encodeURIComponent(currentListMode.listId)}; path=/; max-age=2592000; SameSite=None; Secure`;
    } else {
      document.cookie = "bookmarklet_list_id=; path=/; max-age=0";
    }
  } catch (e) {
    console.warn("Bookmarklet cookie:", e);
  }
}

async function loadList(user) {
  const grid = document.getElementById("grid");
  if (currentListMode === "personal" || (typeof currentListMode === "object" && currentListMode?.type === "personal")) {
    const listId = currentListMode === "personal" ? "personal" : currentListMode.listId;
    try {
      movies = await getPersonalListMovies(user.uid, listId);
    } catch (e) {
      console.error("Failed to load your list:", e);
      movies = [];
    }
  } else if (typeof currentListMode === "object" && currentListMode?.type === "shared") {
    try {
      movies = await getSharedListMovies(currentListMode.listId);
    } catch (e) {
      console.error("Failed to load shared list:", e);
      movies = [];
    }
  } else {
    movies = [];
  }
  return movies;
}

function getCurrentListValue() {
  if (currentListMode === "personal") return "personal";
  if (typeof currentListMode === "object" && currentListMode?.type === "personal") return currentListMode.listId;
  if (typeof currentListMode === "object" && currentListMode?.type === "shared") return currentListMode.listId;
  return "personal";
}

function getCurrentListLabel() {
  if (currentListMode === "personal") {
    const p = personalLists.find((l) => l.id === "personal");
    return p?.name || "My list";
  }
  if (typeof currentListMode === "object" && currentListMode?.type === "personal") {
    const p = personalLists.find((l) => l.id === currentListMode.listId);
    return p?.name || currentListMode.name || "Personal list";
  }
  if (typeof currentListMode === "object" && currentListMode?.type === "shared") return currentListMode.name || "Shared list";
  return "My list";
}

function renderListSelector() {
  const dropdown = document.getElementById("list-selector");
  const trigger = document.getElementById("list-selector-trigger");
  const valueEl = trigger?.querySelector(".custom-dropdown-value");
  const panel = document.getElementById("list-selector-panel");
  if (!dropdown || !trigger || !valueEl || !panel) return;

  const currentVal = getCurrentListValue();
  valueEl.textContent = getCurrentListLabel();
  updateModalListBtn();

  const iconPerson = '<svg class="custom-dropdown-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>';
  const iconGroup = '<svg class="custom-dropdown-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>';

  panel.innerHTML = "";
  const items = [
    ...personalLists.map((l) => ({ value: l.id, label: l.name || "Personal list", icon: iconPerson })),
    ...sharedLists.map((l) => ({ value: l.id, label: l.name || "Shared list", icon: iconGroup })),
  ];
  items.forEach(({ value, label, icon }) => {
    const div = document.createElement("div");
    div.className = "custom-dropdown-item";
    div.setAttribute("role", "option");
    div.dataset.value = value;
    div.innerHTML = (icon ? icon : "") + "<span class=\"custom-dropdown-item-text\">" + label + "</span>";
    div.setAttribute("aria-selected", value === currentVal ? "true" : "false");
    panel.appendChild(div);
  });
}

function updateCopyInviteButton() {
  updateHeaderTitle();
  const btn = document.getElementById("copy-invite-btn");
  if (!btn) return;
  const isShared = typeof currentListMode === "object" && currentListMode?.type === "shared";
  btn.style.display = isShared ? "inline-flex" : "none";
  const textEl = btn.querySelector(".copy-invite-text");
  if (textEl) textEl.textContent = "Copy invite link";
  btn.disabled = false;
}

function showSharedModal(title, bodyHtml) {
  const modal = document.getElementById("shared-modal");
  const titleEl = document.getElementById("shared-modal-title");
  const bodyEl = document.getElementById("shared-modal-body");
  if (titleEl) titleEl.textContent = title;
  if (bodyEl) bodyEl.innerHTML = bodyHtml;
  if (modal) {
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
  }
}

function hideSharedModal() {
  const modal = document.getElementById("shared-modal");
  if (modal) {
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
  }
}

function showListsModal() {
  const modal = document.getElementById("lists-modal");
  if (modal) {
    renderListsModalContent();
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
  }
}

function hideListsModal() {
  const modal = document.getElementById("lists-modal");
  if (modal) {
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
  }
}

let countryModalAbortController = null;

function showCountryModal({ initialCode = "IL", onSave } = {}) {
  const modal = document.getElementById("country-modal");
  const searchInput = document.getElementById("country-search");
  const dropdown = document.getElementById("country-dropdown");
  const listEl = document.getElementById("country-dropdown-list");
  const saveBtn = document.getElementById("country-save-btn");
  if (!modal || !searchInput || !dropdown || !listEl || !saveBtn) return Promise.reject(new Error("Country modal elements missing"));

  countryModalAbortController?.abort();
  countryModalAbortController = new AbortController();
  const ac = countryModalAbortController;

  let selected = COUNTRIES.find((c) => c.code === initialCode) || COUNTRIES[0];

  function renderList(filter = "") {
    const q = filter.trim().toLowerCase();
    const filtered = q
      ? COUNTRIES.filter((c) => c.searchKey.includes(q))
      : COUNTRIES;
    listEl.innerHTML = filtered
      .map(
        (c) =>
          `<button type="button" class="country-dropdown-item" role="option" data-code="${c.code}" aria-selected="${c.code === selected.code}">${c.flag} ${escapeHtml(c.name)}</button>`
      )
      .join("");
    listEl.querySelectorAll(".country-dropdown-item").forEach((btn) => {
      btn.addEventListener(
        "click",
        () => {
          selected = COUNTRIES.find((x) => x.code === btn.dataset.code) || selected;
          searchInput.value = selected.name;
          renderList(searchInput.value);
          dropdown.classList.add("open");
        },
        { signal: ac.signal }
      );
    });
  }

  searchInput.value = selected.name;
  renderList();

  searchInput.addEventListener(
    "input",
    () => {
      const q = searchInput.value;
      renderList(q);
      dropdown.classList.add("open");
      searchInput.setAttribute("aria-expanded", "true");
    },
    { signal: ac.signal }
  );
  searchInput.addEventListener(
    "focus",
    () => {
      dropdown.classList.add("open");
      searchInput.setAttribute("aria-expanded", "true");
    },
    { signal: ac.signal }
  );

  const closeDropdown = (e) => {
    if (!searchInput.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.classList.remove("open");
      searchInput.setAttribute("aria-expanded", "false");
      document.removeEventListener("click", closeDropdown);
    }
  };
  document.addEventListener("click", closeDropdown);

  return new Promise((resolve) => {
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
    searchInput.focus();

    saveBtn.onclick = async () => {
      document.removeEventListener("click", closeDropdown);
      ac.abort();
      modal.classList.remove("open");
      modal.setAttribute("aria-hidden", "true");
      if (onSave) await onSave(selected.code, selected.name);
      resolve({ code: selected.code, name: selected.name });
    };
  });
}

function hideCountryModal() {
  const modal = document.getElementById("country-modal");
  if (modal) {
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
  }
  countryModalResolve = null;
}

function updateCountryDropdownRow() {
  const btn = document.getElementById("auth-country-btn");
  if (!btn) return;
  const c = COUNTRIES.find((x) => x.code === userCountryCode);
  btn.textContent = `Country: ${c ? c.flag + " " + c.name : userCountryCode}`;
}

let deleteConfirmResolve = null;

function showDeleteConfirmModal(listName, count, onConfirm, { isLeave = false, isSharedDelete = false } = {}) {
  const modal = document.getElementById("delete-confirm-modal");
  const msg = document.getElementById("delete-confirm-message");
  const titleEl = document.getElementById("delete-confirm-title");
  const actionBtn = document.getElementById("delete-confirm-delete");
  if (!modal || !msg || !actionBtn) return;
  if (isLeave) {
    msg.textContent = `Leave ${listName}? You will lose access but other members are unaffected.`;
    if (titleEl) titleEl.textContent = "Leave list?";
    actionBtn.textContent = "Leave";
  } else {
    msg.textContent = isSharedDelete
      ? `Delete ${listName}? This will permanently delete the list for all members.`
      : `Delete ${listName}? This will permanently remove all ${count} titles and cannot be undone.`;
    if (titleEl) titleEl.textContent = "Delete list?";
    actionBtn.textContent = "Delete";
  }
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  deleteConfirmResolve = onConfirm;
}

function hideDeleteConfirmModal() {
  const modal = document.getElementById("delete-confirm-modal");
  if (modal) {
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
  }
  deleteConfirmResolve = null;
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function renderListsModalContent() {
  const listEl = document.getElementById("lists-modal-list");
  if (!listEl) return;

  const iconPerson = '<svg class="custom-dropdown-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>';
  const iconGroup = '<svg class="custom-dropdown-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>';
  const user = auth.currentUser;

  listEl.innerHTML = "";

  personalLists.forEach((l) => {
    const li = document.createElement("li");
    li.className = "lists-modal-list-item";
    li.dataset.value = l.id;
    li.dataset.type = "personal";
    li.dataset.count = String(l.count || 0);
    li.innerHTML = `
      <span class="lists-modal-list-item-name">${iconPerson}<span class="lists-modal-list-item-name-text">${escapeHtml(l.name || "My list")}</span></span>
      <div class="lists-modal-list-item-actions">
        <button type="button" class="lists-modal-list-item-action lists-modal-rename-btn" data-list-id="${l.id}" data-type="personal">Rename</button>
        <button type="button" class="lists-modal-list-item-action lists-modal-list-item-action--delete lists-modal-delete-btn" data-list-id="${l.id}" data-type="personal">Delete</button>
      </div>
    `;
    listEl.appendChild(li);
  });

  sharedLists.forEach((l) => {
    // Only show Delete if current user created the list (uid matches Firestore ownerId)
    const isOwner = !!(user && l.ownerId && String(l.ownerId) === String(user.uid));
    const li = document.createElement("li");
    li.className = "lists-modal-list-item";
    li.dataset.value = l.id;
    li.dataset.type = "shared";
    li.dataset.count = String((l.items || []).length);
    li.innerHTML = `
      <span class="lists-modal-list-item-name">${iconGroup}<span class="lists-modal-list-item-name-text">${escapeHtml(l.name || "Shared list")}</span></span>
      <div class="lists-modal-list-item-actions">
        <button type="button" class="lists-modal-list-item-action lists-modal-rename-btn" data-list-id="${l.id}" data-type="shared">Rename</button>
        ${isOwner
          ? `<button type="button" class="lists-modal-list-item-action lists-modal-list-item-action--delete lists-modal-delete-btn" data-list-id="${l.id}" data-type="shared">Delete</button>`
          : `<button type="button" class="lists-modal-list-item-leave lists-modal-leave-btn" data-list-id="${l.id}">Leave</button>`
        }
      </div>
    `;
    listEl.appendChild(li);
  });
}

async function handleListSelect(val) {
  const user = auth.currentUser;
  if (!user) return;
  const grid = document.getElementById("grid");
  const filters = document.getElementById("content-filters");

  const personalList = personalLists.find((l) => l.id === val);
  const sharedList = sharedLists.find((l) => l.id === val);

  if (personalList) {
    currentListMode = val === "personal" ? "personal" : { type: "personal", listId: val, name: personalList.name };
    saveLastList(user, currentListMode);
    movies = await loadList(user);
    setBookmarkletCookie(user);
    if (!movies.length) {
      if (filters) filters.style.display = "none";
      updateFilterCount(0);
      if (grid) grid.innerHTML = '<div class="empty-state">Your list is empty. Add titles from <a href="./bookmarklet.html">IMDb</a>.</div>';
    } else {
      if (filters) filters.style.display = "";
      buildCards();
      renderGenreFilter();
    }
    updateCopyInviteButton();
  } else if (sharedList) {
    currentListMode = { type: "shared", listId: sharedList.id, name: sharedList.name };
    saveLastList(user, currentListMode);
    movies = await loadList(user);
    setBookmarkletCookie(user);
    const filters = document.getElementById("content-filters");
    if (filters) filters.style.display = movies.length ? "" : "none";
    if (movies.length) {
      buildCards();
      renderGenreFilter();
    } else {
      updateFilterCount(0);
      if (grid) grid.innerHTML = '<div class="empty-state">This shared list is empty.</div>';
    }
    updateCopyInviteButton();
  } else {
    currentListMode = "personal";
    saveLastList(user, currentListMode);
    movies = await loadList(user);
    setBookmarkletCookie(user);
    if (filters) filters.style.display = movies.length ? "" : "none";
    if (movies.length) {
      buildCards();
      renderGenreFilter();
    } else {
      updateFilterCount(0);
      if (grid) grid.innerHTML = '<div class="empty-state">Your list is empty. Add titles from <a href="./bookmarklet.html">IMDb</a>.</div>';
    }
    updateCopyInviteButton();
  }
  renderListSelector();
}

// Auth state + load user's movies (each account has its own list)
function init() {
  const grid = document.getElementById("grid");
  grid.innerHTML = '<div class="empty-state">Loading…</div>';

  const joinListId = new URLSearchParams(window.location.search).get("join");

  onAuthStateChanged(auth, async (user) => {
    updateAuthUI(user);
    if (!user) {
      currentListMode = "personal";
      sharedLists = [];
      movies = [];
      userCountryCode = "IL";
      const wrap = document.getElementById("list-selector-wrap");
      if (wrap) wrap.style.display = "none";
      updateFilterCount("");
      grid.innerHTML = '<div class="empty-state">Sign in to see your watchlist.</div>';
      return;
    }

    let profile = { country: null, countryName: null };
    try {
      profile = await getUserProfile(user.uid);
    } catch (e) {
      console.warn("getUserProfile failed:", e);
    }

    if (!profile.country) {
      grid.innerHTML = '<div class="empty-state">Loading…</div>';
      const result = await showCountryModal({
        initialCode: "IL",
        onSave: async (code, name) => {
          await setUserCountry(user.uid, code, name);
          userCountryCode = code;
          updateCountryDropdownRow();
        },
      });
      userCountryCode = result?.code || "IL";
      updateCountryDropdownRow();
    } else {
      userCountryCode = profile.country;
      updateCountryDropdownRow();
    }

    try {
      sharedLists = await getSharedListsForUser(user.uid);
    } catch (e) {
      sharedLists = [];
    }
    try {
      personalLists = await getPersonalLists(user.uid);
    } catch (e) {
      console.warn("getPersonalLists failed, using default:", e);
      personalLists = [{ id: "personal", name: "My list", count: 0, isDefault: true }];
    }

    const wrap = document.getElementById("list-selector-wrap");
    if (wrap) wrap.style.display = "flex";

    if (joinListId) {
      const apiBase = window.location.origin;
      try {
        const res = await fetch(apiBase + "/.netlify/functions/join-shared-list", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ listId: joinListId }),
        });
        const data = await res.json();
        if (data.ok) {
          sharedLists = await getSharedListsForUser(user.uid);
          currentListMode = { type: "shared", listId: joinListId, name: data.name || "Shared list" };
          saveLastList(user, currentListMode);
        }
      } catch (e) {
        console.warn("Join failed:", e);
      }
    } else {
      const last = getLastList(user);
      if (last === "personal") {
        currentListMode = "personal";
      } else if (last) {
        const personalList = personalLists.find((l) => l.id === last);
        if (personalList) {
          currentListMode = last === "personal" ? "personal" : { type: "personal", listId: last, name: personalList.name };
        } else {
          let list = sharedLists.find((l) => l.id === last);
          if (!list) {
            try {
              const fetched = await getSharedList(last);
              if (fetched && (fetched.ownerId === user.uid || (Array.isArray(fetched.members) && fetched.members.includes(user.uid)))) {
                sharedLists.push(fetched);
                list = fetched;
              }
            } catch (_) {}
          }
          if (list) {
            currentListMode = { type: "shared", listId: list.id, name: list.name };
          }
        }
      }
    }

    renderListSelector();
    updateCopyInviteButton();

    movies = await loadList(user);
    setBookmarkletCookie(user);

    if (!movies.length) {
      const filters = document.getElementById("content-filters");
      if (filters) filters.style.display = "none";
      updateFilterCount(0);
      const isShared = typeof currentListMode === "object" && currentListMode?.type === "shared";
      grid.innerHTML = isShared
        ? '<div class="empty-state">This shared list is empty. Add titles from <a href="./bookmarklet.html">IMDb</a>.</div>'
        : '<div class="empty-state">Your list is empty. Add titles from <a href="./bookmarklet.html">IMDb</a>.</div>';
    } else {
      const filters = document.getElementById("content-filters");
      if (filters) filters.style.display = "";
      buildCards();
      renderGenreFilter();
    }
    updateCopyInviteButton();
  });

  // Custom dropdown: toggle, select, close on outside click
  const dropdown = document.getElementById("list-selector");
  const trigger = document.getElementById("list-selector-trigger");
  const panel = document.getElementById("list-selector-panel");
  if (dropdown && trigger && panel) {
    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = dropdown.getAttribute("data-open") === "true";
      dropdown.setAttribute("data-open", !open);
      trigger.setAttribute("aria-expanded", !open);
      panel.setAttribute("aria-hidden", open);
    });
    panel.addEventListener("click", async (e) => {
      const item = e.target.closest(".custom-dropdown-item");
      if (!item) return;
      const val = item.dataset.value;
      dropdown.setAttribute("data-open", "false");
      trigger.setAttribute("aria-expanded", "false");
      panel.setAttribute("aria-hidden", "true");
      await handleListSelect(val);
    });
    document.addEventListener("click", (e) => {
      if (dropdown.contains(e.target)) return;
      if (dropdown.getAttribute("data-open") === "true") {
        dropdown.setAttribute("data-open", "false");
        trigger.setAttribute("aria-expanded", "false");
        panel.setAttribute("aria-hidden", "true");
      }
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const deleteModal = document.getElementById("delete-confirm-modal");
      if (deleteModal?.classList.contains("open")) {
        hideDeleteConfirmModal();
        return;
      }
      const listsModal = document.getElementById("lists-modal");
      if (listsModal?.classList.contains("open")) {
        hideListsModal();
        return;
      }
      const d = document.getElementById("list-selector");
      const p = document.getElementById("list-selector-panel");
      const t = document.getElementById("list-selector-trigger");
      if (d?.getAttribute("data-open") === "true") {
        d.setAttribute("data-open", "false");
        t?.setAttribute("aria-expanded", "false");
        p?.setAttribute("aria-hidden", "true");
      }
      const authDd = document.getElementById("auth-dropdown");
      if (authDd?.getAttribute("aria-hidden") === "false") {
        authDd.setAttribute("aria-hidden", "true");
        document.getElementById("auth-avatar-btn")?.setAttribute("aria-expanded", "false");
      }
    }
  });

  document.getElementById("copy-invite-btn")?.addEventListener("click", async () => {
    if (typeof currentListMode !== "object" || currentListMode?.type !== "shared") return;
    const shareUrl = window.location.origin + window.location.pathname + "?join=" + currentListMode.listId;
    try {
      await navigator.clipboard.writeText(shareUrl);
      const btn = document.getElementById("copy-invite-btn");
      if (btn) {
        const textEl = btn.querySelector(".copy-invite-text");
        if (textEl) textEl.textContent = "Copied!";
        btn.disabled = true;
        setTimeout(() => {
          if (textEl) textEl.textContent = "Copy invite link";
          btn.disabled = false;
        }, 2000);
      }
    } catch (e) {
      alert("Could not copy. The link is: " + shareUrl);
    }
  });

  document.getElementById("shared-modal-close")?.addEventListener("click", hideSharedModal);
  document.getElementById("shared-modal")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) hideSharedModal();
  });

  // Lists management modal
  document.getElementById("list-settings-btn")?.addEventListener("click", showListsModal);
  document.getElementById("lists-modal-close")?.addEventListener("click", hideListsModal);
  document.getElementById("lists-modal")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) hideListsModal();
  });

  const bookmarkletBtn = document.getElementById("lists-bookmarklet-btn");
  if (bookmarkletBtn) {
    const scriptUrl = window.location.origin + "/bookmarklet.js?v=9";
    bookmarkletBtn.href = "javascript:(function(){var s=document.createElement('script');s.src='" + scriptUrl + "';document.body.appendChild(s);})();";
    bookmarkletBtn.addEventListener("click", (e) => {
      e.preventDefault();
    });
  }

  document.getElementById("lists-new-personal-btn")?.addEventListener("click", async () => {
    const user = auth.currentUser;
    if (!user) return;
    const name = prompt("Enter a name for the new personal list:", "Personal list");
    if (!name) return;
    try {
      const listId = await createPersonalList(user.uid, name.trim());
      if (!listId) {
        alert("Failed to create list. Please try again.");
        return;
      }
      personalLists = await getPersonalLists(user.uid);
      currentListMode = { type: "personal", listId, name: name.trim() };
      saveLastList(user, currentListMode);
      renderListSelector();
      renderListsModalContent();
      movies = await loadList(user);
      setBookmarkletCookie(user);
      const filters = document.getElementById("content-filters");
      if (filters) filters.style.display = movies.length ? "" : "none";
      if (movies.length) {
        buildCards();
        renderGenreFilter();
      } else {
        updateFilterCount(0);
        const grid = document.getElementById("grid");
        if (grid) grid.innerHTML = '<div class="empty-state">Your list is empty. Add titles from <a href="./bookmarklet.html">IMDb</a>.</div>';
      }
      updateCopyInviteButton();
    } catch (err) {
      alert("Failed to create: " + (err.message || "Unknown error"));
    }
  });

  document.getElementById("lists-create-btn")?.addEventListener("click", async () => {
    const user = auth.currentUser;
    if (!user) return;
    const name = prompt("Enter a name for the shared list:", "Family watchlist");
    if (!name) return;
    try {
      const listId = await createSharedList(user.uid, name.trim());
      sharedLists = await getSharedListsForUser(user.uid);
      currentListMode = { type: "shared", listId, name: name.trim() };
      saveLastList(user, currentListMode);
      renderListSelector();
      renderListsModalContent();
      const shareUrl = window.location.origin + window.location.pathname + "?join=" + listId;
      showSharedModal("Shared list created", `
        <p>Share this link for others to join:</p>
        <p class="share-link" id="share-link-text">${shareUrl}</p>
        <button type="button" class="auth-btn" id="copy-share-link-btn" style="margin-top:0.75rem">Copy link</button>
        <p style="margin-top:0.75rem;font-size:0.85rem;color:var(--muted)">Anyone with the link can join. They must be signed in.</p>
      `);
      document.getElementById("copy-share-link-btn")?.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(shareUrl);
          const btn = document.getElementById("copy-share-link-btn");
          if (btn) { btn.textContent = "Copied!"; btn.disabled = true; }
        } catch (err) {
          alert("Could not copy. Select and copy the link above.");
        }
      });
      movies = await loadList(user);
      setBookmarkletCookie(user);
      const filters = document.getElementById("content-filters");
      if (filters) filters.style.display = "";
      buildCards();
      renderGenreFilter();
      updateCopyInviteButton();
    } catch (err) {
      alert("Failed to create: " + (err.message || "Unknown error"));
    }
  });
  document.getElementById("lists-join-btn")?.addEventListener("click", async () => {
    const user = auth.currentUser;
    if (!user) return;
    const input = document.getElementById("lists-join-input");
    const url = input?.value?.trim() || "";
    if (!url) {
      alert("Paste the invite link in the field above.");
      return;
    }
    const m = url.match(/[?&]join=([a-z0-9]+)/i);
    const listId = m ? m[1] : null;
    if (!listId) {
      alert("Invalid link. Paste the full URL from the person who shared the list.");
      return;
    }
    try {
      const apiBase = window.location.origin;
      const res = await fetch(apiBase + "/.netlify/functions/join-shared-list", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listId }),
      });
      const data = await res.json();
      if (data.ok) {
        sharedLists = await getSharedListsForUser(user.uid);
        currentListMode = { type: "shared", listId, name: data.name || "Shared list" };
        saveLastList(user, currentListMode);
        renderListSelector();
        renderListsModalContent();
        movies = await loadList(user);
        setBookmarkletCookie(user);
        const filters = document.getElementById("content-filters");
        if (filters) filters.style.display = "";
        buildCards();
        renderGenreFilter();
        updateCopyInviteButton();
        if (input) input.value = "";
      } else {
        alert(data.error || "Failed to join");
      }
    } catch (err) {
      alert("Failed to join: " + (err.message || "Unknown error"));
    }
  });
  document.getElementById("lists-modal-list")?.addEventListener("click", async (e) => {
    const user = auth.currentUser;
    if (!user) return;

    const renameBtn = e.target.closest(".lists-modal-rename-btn");
    if (renameBtn) {
      const listId = renameBtn.dataset.listId;
      const type = renameBtn.dataset.type;
      const li = renameBtn.closest(".lists-modal-list-item");
      const nameSpan = li?.querySelector(".lists-modal-list-item-name-text");
      if (!nameSpan || !listId) return;
      const currentName = nameSpan.textContent;
      const input = document.createElement("input");
      input.type = "text";
      input.className = "lists-modal-list-item-edit";
      input.value = currentName;
      input.style.width = `${Math.max(120, nameSpan.offsetWidth)}px`;
      nameSpan.replaceWith(input);
      input.focus();
      input.select();
      const saveRename = async () => {
        if (!document.contains(input)) return;
        const newName = input.value.trim();
        if (!newName) {
          const span = document.createElement("span");
          span.className = "lists-modal-list-item-name-text";
          span.textContent = currentName;
          input.replaceWith(span);
          return;
        }
        try {
          if (type === "personal") {
            await renamePersonalList(user.uid, listId, newName);
          } else {
            await renameSharedList(listId, newName);
          }
          personalLists = await getPersonalLists(user.uid);
          sharedLists = await getSharedListsForUser(user.uid);
          if (typeof currentListMode === "object" && currentListMode?.listId === listId) {
            currentListMode = { ...currentListMode, name: newName };
          }
          renderListSelector();
          renderListsModalContent();
        } catch (err) {
          alert("Failed to rename: " + (err.message || "Unknown error"));
          const span = document.createElement("span");
          span.className = "lists-modal-list-item-name-text";
          span.textContent = currentName;
          input.replaceWith(span);
        }
      };
      input.addEventListener("blur", saveRename);
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          input.blur();
        }
        if (ev.key === "Escape") {
          const span = document.createElement("span");
          span.className = "lists-modal-list-item-name-text";
          span.textContent = currentName;
          input.replaceWith(span);
        }
      });
      return;
    }

    const deleteBtn = e.target.closest(".lists-modal-delete-btn");
    const leaveBtn = e.target.closest(".lists-modal-leave-btn");
    if (deleteBtn || leaveBtn) {
      const listId = (deleteBtn || leaveBtn).dataset.listId;
      const li = (deleteBtn || leaveBtn).closest(".lists-modal-list-item");
      const listName = li?.querySelector(".lists-modal-list-item-name-text")?.textContent || "list";
      const count = parseInt(li?.dataset.count || "0", 10);
      const isLeave = !!leaveBtn;
      const type = li?.dataset.type;

      if (!isLeave && type === "personal" && personalLists.length <= 1) {
        alert("You must have at least one personal list.");
        return;
      }

      showDeleteConfirmModal(listName, count, async () => {
        hideDeleteConfirmModal();
        try {
          if (isLeave) {
            await leaveSharedList(user.uid, listId);
          } else {
            const type = li?.dataset.type;
            if (type === "personal") {
              await deletePersonalList(user.uid, listId);
            } else {
              await deleteSharedList(listId);
            }
          }
          personalLists = await getPersonalLists(user.uid);
          sharedLists = await getSharedListsForUser(user.uid);
          if (typeof currentListMode === "object" && currentListMode?.listId === listId) {
            currentListMode = "personal";
            saveLastList(user, currentListMode);
            movies = await loadList(user);
            setBookmarkletCookie(user);
            const grid = document.getElementById("grid");
            const filters = document.getElementById("content-filters");
            if (!movies.length) {
              if (filters) filters.style.display = "none";
              updateFilterCount(0);
              if (grid) grid.innerHTML = '<div class="empty-state">Your list is empty. Add titles from <a href="./bookmarklet.html">IMDb</a>.</div>';
            } else {
              if (filters) filters.style.display = "";
              buildCards();
              renderGenreFilter();
            }
          }
          renderListSelector();
          renderListsModalContent();
          updateCopyInviteButton();
        } catch (err) {
          alert("Failed: " + (err.message || "Unknown error"));
        }
      }, { isLeave, isSharedDelete: !isLeave && type === "shared" });
      return;
    }
  });

  document.getElementById("delete-confirm-close")?.addEventListener("click", hideDeleteConfirmModal);
  document.getElementById("delete-confirm-cancel")?.addEventListener("click", hideDeleteConfirmModal);
  document.getElementById("delete-confirm-delete")?.addEventListener("click", () => {
    if (deleteConfirmResolve) deleteConfirmResolve();
  });
  document.getElementById("delete-confirm-modal")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) hideDeleteConfirmModal();
  });
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

