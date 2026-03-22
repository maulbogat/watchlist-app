import {
  auth,
  movieKey,
  setStatus,
  setSharedListStatus,
  setPersonalListStatus,
  removeTitle,
  removeFromSharedList,
  removeFromPersonalList,
} from "../../firebase.js";
import {
  currentListMode,
  movies,
  setMovies,
  userCountryCode,
  currentStatus,
  STATUS_ORDER,
  STATUS_LABELS,
} from "../store/state.js";
import { escapeHtml } from "../lib/utils.js";
import { getFilteredTitles, updateFilterCount } from "./filters.js";
import { isPlayableYoutubeTrailerId } from "../../lib/youtube-trailer-id.js";
import { listHandlerBridge } from "../data/list-handlers-bridge.js";

/** Watch-provider names for TMDB region: prefers servicesByRegion[country], then legacy services. */
export function servicesForMovie(m, countryCode) {
  const code = (countryCode || "IL").toString().toUpperCase().slice(0, 2);
  const map = m.servicesByRegion;
  if (map && typeof map === "object" && Array.isArray(map[code])) {
    return map[code];
  }
  return Array.isArray(m.services) ? m.services : [];
}

/** Stored TMDB YouTube trailer key — playable only if valid 11-char YouTube id */
export function hasPlayableTrailerYoutubeId(m) {
  return isPlayableYoutubeTrailerId(m?.youtubeId);
}

export function renderServiceChips(services, { limit } = {}) {
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

export function closeAllStatusDropdowns() {
  document.querySelectorAll(".status-dropdown.open").forEach((d) => d.classList.remove("open"));
  document.querySelectorAll(".status-badge[aria-expanded='true']").forEach((b) => b.setAttribute("aria-expanded", "false"));
}

export async function setStatusFromCard(m, status) {
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
    listHandlerBridge.updateModalStatusBtn();
  } catch (err) {
    console.error("Failed to update status:", err);
    alert("Failed to update. Please try again.");
  }
}

export function showRemoveToast(m, onUndo, onRemove) {
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

export async function removeFromCard(m) {
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
    setMovies(movies.filter((x) => movieKey(x) !== key));
    buildCards();
    listHandlerBridge.closeModal();
  } catch (err) {
    console.error("Failed to remove:", err);
    alert("Failed to remove. Please try again.");
  }
}

export function buildCards() {
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
      archive: "No archived titles yet.",
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
    const displayStatus = s;
    const statusTabKey =
      s === "watched" ? "watched" : s === "archive" ? "archive" : "to-watch";
    const statusLabels = { ...STATUS_LABELS };
    const statusIcons = {
      "to-watch": '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" fill="none"/><circle cx="12" cy="12" r="3" fill="none"/>',
      watched: '<path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>',
      archive:
        '<path d="M4 7h16M6 7V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2M4 7v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7M9 12h6" fill="none"/>',
      "maybe-later":
        '<circle cx="12" cy="12" r="9" fill="none"/><path d="M12 7v5l3 2" fill="none"/>',
    };
    const iconKey = displayStatus in statusIcons ? displayStatus : "to-watch";
    const useFill = displayStatus === "watched";
    const statusBadge = `<div class="status-badge-wrap">
      <button type="button" class="status-badge status-${displayStatus}" aria-label="Change status" title="Change status" data-status="${displayStatus}" aria-haspopup="true" aria-expanded="false">
        <svg viewBox="0 0 24 24" fill="${useFill ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2">${statusIcons[iconKey]}</svg>
      </button>
      <div class="status-dropdown" role="menu" aria-label="Move to">
        ${STATUS_ORDER.map(
          (st) =>
            `<button type="button" class="status-dropdown-item ${st === statusTabKey ? "active" : ""}" role="menuitem" data-status="${st}">${statusLabels[st]}</button>`
        ).join("")}
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
      listHandlerBridge.openModal(m);
    });
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") listHandlerBridge.openModal(m);
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
          const raw = m.status || "to-watch";
          const current =
            raw === "watched" ? "watched" : raw === "archive" ? "archive" : "to-watch";
          if (status && status !== current) setStatusFromCard(m, status);
          dropdown.classList.remove("open");
          badgeBtn.setAttribute("aria-expanded", "false");
        });
      });
    }
    grid.appendChild(card);
  });
}
