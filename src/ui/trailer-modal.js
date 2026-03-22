import {
  auth,
  movieKey,
  removeFromSharedList,
  addToSharedList,
  addToPersonalList,
  removeFromPersonalList,
  getPersonalListMovies,
  getSharedListMovies,
} from "../../firebase.js";
import {
  currentModalMovie,
  setCurrentModalMovie,
  currentListMode,
  personalLists,
  sharedLists,
  setMovies,
  userCountryCode,
  STATUS_ORDER,
  STATUS_LABELS,
  CHECK_SVG,
} from "../store/state.js";
import { getCurrentListLabel, getListsContainingMovie } from "../data/lists.js";
import { displayListName, escapeHtml } from "../lib/utils.js";
import {
  buildCards,
  setStatusFromCard,
  hasPlayableTrailerYoutubeId,
  servicesForMovie,
  renderServiceChips,
  closeAllStatusDropdowns,
} from "./cards.js";

export function renderModalFooter(m, youtubeLinkHtml) {
  const raw = m.status || "to-watch";
  const s = raw === "watched" ? "watched" : raw === "archive" ? "archive" : "to-watch";
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

export function updateModalStatusBtn() {
  if (!currentModalMovie) return;
  const trigger = document.querySelector(".modal-status-trigger");
  const raw = currentModalMovie.status || "to-watch";
  const tabKey = raw === "watched" ? "watched" : raw === "archive" ? "archive" : "to-watch";
  if (trigger) trigger.querySelector(".modal-action-label").textContent = STATUS_LABELS[tabKey];
  document.querySelectorAll(".modal-action-dropdown-item[data-status]").forEach((btn) => {
    const isActive = btn.dataset.status === tabKey;
    btn.innerHTML = STATUS_LABELS[btn.dataset.status] + (isActive ? " " + CHECK_SVG : "");
  });
}

export function updateModalListBtn() {
  const labelEl = document.querySelector(".modal-add-to-list-trigger .modal-list-label");
  if (labelEl) labelEl.textContent = getCurrentListLabel();
}

export function attachModalFooterHandlers(footer, m) {
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
        const raw = m.status || "to-watch";
        const current = raw === "watched" ? "watched" : raw === "archive" ? "archive" : "to-watch";
        if (status && status !== current) await setStatusFromCard(m, status);
        statusPanel.classList.remove("open");
        statusTrigger.setAttribute("aria-expanded", "false");
      });
    });
  }

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
          const label = displayListName(l.name);
          const name = escapeHtml(label);
          items.push(`<button type="button" class="modal-action-dropdown-item" role="menuitem" data-type="personal" data-list-id="${l.id}" data-list-name="${name}" data-in-list="${inList}">${name}${inList ? " " + CHECK_SVG : ""}</button>`);
        }
        for (const l of sharedLists) {
          const inList = containing.has(l.id);
          const label = displayListName(l.name);
          const name = escapeHtml(label);
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
                setMovies(type === "personal" ? await getPersonalListMovies(user.uid, listId) : await getSharedListMovies(listId));
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

export function openModal(m) {
  setCurrentModalMovie(m);
  const modal = document.getElementById("modal");
  const titleEl = document.getElementById("modal-title");
  const footer = document.getElementById("modal-footer");

  titleEl.textContent = m.title;
  titleEl.dir = /[\u0590-\u05FF]/.test(m.title) ? "rtl" : "ltr";

  const videoWrap = modal.querySelector(".video-wrap");
  const imdbUrl = m.imdbId ? `https://www.imdb.com/title/${m.imdbId}/` : null;

  if (hasPlayableTrailerYoutubeId(m)) {
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
  } else {
    videoWrap.style.background = "#0d0d10";
    videoWrap.innerHTML = `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1.25rem;padding:1.5rem;text-align:center;">
      <p style="font-family:var(--font-title);font-size:1.25rem;letter-spacing:0.06em;color:var(--text);margin:0">No trailer available</p>
      <p style="font-size:0.88rem;color:var(--muted);margin:0;max-width:22rem;line-height:1.45">There is no YouTube trailer on TMDB for this title, or it has not been loaded yet.</p>
      ${
        imdbUrl
          ? `<a href="${imdbUrl}" target="_blank" rel="noopener noreferrer" class="modal-action-btn modal-youtube-link" style="display:inline-flex;margin-top:0.25rem">View on IMDb &#x2197;</a>`
          : ""
      }
    </div>`;
    const extra = imdbUrl
      ? `<a href="${imdbUrl}" target="_blank" class="modal-action-btn modal-youtube-link">IMDb &#x2197;</a>`
      : "";
    footer.innerHTML = renderModalFooter(m, extra);
    attachModalFooterHandlers(footer, m);
  }

  modal.classList.add("open");
  document.body.style.overflow = "hidden";
}

export function closeModal() {
  setCurrentModalMovie(null);
  const modal = document.getElementById("modal");
  modal.classList.remove("open");
  const videoWrap = modal.querySelector(".video-wrap");
  videoWrap.innerHTML = `<iframe id="modal-iframe" allowfullscreen allow="autoplay; encrypted-media"></iframe>`;
  videoWrap.style.background = "#000";
  document.getElementById("modal-footer").innerHTML = "";
  document.body.style.overflow = "";
}

/** Close button, backdrop, Escape, and status-dropdown dismiss (same as former app.js top-level). */
export function wireTrailerModalListeners() {
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
}
