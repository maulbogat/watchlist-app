import { personalLists, sharedLists, currentListMode } from "../store/state.js";
import { getCurrentListValue, getCurrentListLabel, handleListSelect } from "../data/lists.js";
import { displayListName } from "../lib/utils.js";
import { updateModalListBtn } from "./trailer-modal.js";
import { hideDeleteConfirmModal, hideListsModal } from "./lists-modals.js";

export function updateHeaderTitle() {
  const el = document.getElementById("header-title");
  if (!el) return;
  el.textContent = "My";
}

export function renderListSelector() {
  const dropdown = document.getElementById("list-selector");
  const trigger = document.getElementById("list-selector-trigger");
  const valueEl = trigger?.querySelector(".custom-dropdown-value");
  const panel = document.getElementById("list-selector-panel");
  if (!dropdown || !trigger || !valueEl || !panel) return;

  const currentVal = getCurrentListValue();
  valueEl.textContent = getCurrentListLabel();
  updateModalListBtn();

  const iconPerson =
    '<svg class="custom-dropdown-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>';
  const iconGroup =
    '<svg class="custom-dropdown-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>';

  panel.innerHTML = "";
  const items = [
    ...personalLists.map((l) => ({ value: l.id, label: displayListName(l.name), icon: iconPerson })),
    ...sharedLists.map((l) => ({ value: l.id, label: displayListName(l.name), icon: iconGroup })),
  ];
  items.forEach(({ value, label, icon }) => {
    const div = document.createElement("div");
    div.className = "custom-dropdown-item";
    div.setAttribute("role", "option");
    div.dataset.value = value;
    div.innerHTML = (icon ? icon : "") + '<span class="custom-dropdown-item-text">' + label + "</span>";
    div.setAttribute("aria-selected", value === currentVal ? "true" : "false");
    panel.appendChild(div);
  });
}

export function updateCopyInviteButton() {
  updateHeaderTitle();
  const btn = document.getElementById("copy-invite-btn");
  if (!btn) return;
  const isShared = typeof currentListMode === "object" && currentListMode?.type === "shared";
  btn.style.display = isShared ? "inline-flex" : "none";
  const textEl = btn.querySelector(".copy-invite-text");
  if (textEl) textEl.textContent = "Copy invite link";
  btn.disabled = false;
}

/** List selector toggle/select/outside-click + copy shared invite link. Call from `init()`. */
export function wireListSelectorAndCopyInvite() {
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
}

/** Escape closes modals, list selector, auth menu. Call once from `init()`. */
export function wireGlobalEscapeListeners() {
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
}

export function wireFileProtocolBanner() {
  if (window.location.protocol !== "file:") return;
  const banner = document.getElementById("file-banner");
  const closeBtn = document.getElementById("file-banner-close");
  if (!banner || !closeBtn) return;
  banner.style.display = "flex";
  closeBtn.addEventListener("click", () => {
    banner.style.display = "none";
  });
}
