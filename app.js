import { movies } from "./data.js";

let currentFilter = "both"; // 'both' | 'movie' | 'show'
let currentStatus = "to-watch"; // 'to-watch' | 'watched'

function getFilteredTitles() {
  const byType = currentFilter === "both" ? movies : movies.filter((m) => m.type === currentFilter);
  const byStatus =
    currentStatus === "watched"
      ? byType.filter((m) => m.watched === true)
      : byType.filter((m) => m.watched !== true);

  return [...byStatus].sort((a, b) =>
    String(a.title).localeCompare(String(b.title), undefined, { sensitivity: "base" })
  );
}

function updateHeaderMeta(visibleCount) {
  const el = document.getElementById("header-meta");
  if (!el) return;
  el.innerHTML = `${visibleCount} titles &nbsp;·&nbsp; Trailers`;
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

    card.innerHTML = `
      <div class="thumb-wrap">
        ${thumbHTML}
        <div class="thumb-overlay"></div>
        <div class="play-btn">
          <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
        </div>
      </div>
      <div class="card-info">
        <div class="card-title">${m.title}</div>
        <div class="card-meta">
          <span class="badge ${badgeClass}">${badgeLabel}</span>
          ${yearStr} &nbsp;·&nbsp; ${m.genre}
        </div>
        ${serviceRow}
      </div>
    `;

    card.addEventListener("click", () => openModal(m));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") openModal(m);
    });
    grid.appendChild(card);
  });
}

function openModal(m) {
  const modal = document.getElementById("modal");
  const titleEl = document.getElementById("modal-title");
  const footer = document.getElementById("modal-footer");

  titleEl.textContent = m.title;

  if (m.youtubeId === "SEARCH") {
    const query = encodeURIComponent(m.title + " official trailer");
    footer.innerHTML = `
      <span>No trailer ID yet &mdash;</span>
      <a href="https://www.youtube.com/results?search_query=${query}" target="_blank"
         style="color: var(--accent); text-decoration: none;">
        Search on YouTube &#x2197;
      </a>
    `;
    const placeholder = modal.querySelector(".video-wrap");
    placeholder.style.background = "#0d0d10";
    placeholder.innerHTML = `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1rem;">
      <div style="font-family:var(--font-title);font-size:2rem;letter-spacing:0.06em;color:var(--muted)">${m.title}</div>
      <a href="https://www.youtube.com/results?search_query=${query}" target="_blank"
         style="font-size:0.85rem;color:var(--accent);text-decoration:none;letter-spacing:0.08em;text-transform:uppercase">
        Find Trailer on YouTube &#x2197;
      </a>
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
      <a href="${watchUrl}" target="_blank" style="color: var(--accent); text-decoration: none;">
        Watch on YouTube &#x2197;
      </a>
    `;
  }

  modal.classList.add("open");
  document.body.style.overflow = "hidden";
}

function closeModal() {
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

buildCards();

