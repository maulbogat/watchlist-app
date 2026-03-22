import {
  auth,
  createSharedList,
  getSharedListsForUser,
  leaveSharedList,
  createPersonalList,
  getPersonalLists,
  renamePersonalList,
  deletePersonalList,
  renameSharedList,
  deleteSharedList,
} from "../../firebase.js";
import {
  movies,
  setMovies,
  currentListMode,
  setCurrentListMode,
  sharedLists,
  setSharedLists,
  personalLists,
  setPersonalLists,
} from "../store/state.js";
import { saveLastList } from "../lib/storage.js";
import { loadList, setBookmarkletCookie } from "../data/lists.js";
import { listHandlerBridge } from "../data/list-handlers-bridge.js";
import { displayListName, escapeHtml } from "../lib/utils.js";

let listNameModalAbortController = null;
let deleteConfirmResolve = null;

export function showSharedModal(title, bodyHtml) {
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

export function hideSharedModal() {
  const modal = document.getElementById("shared-modal");
  if (modal) {
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
  }
}

export function renderListsModalContent() {
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
      <span class="lists-modal-list-item-name">${iconPerson}<span class="lists-modal-list-item-name-text">${escapeHtml(displayListName(l.name))}</span></span>
      <div class="lists-modal-list-item-actions">
        <button type="button" class="lists-modal-list-item-action lists-modal-rename-btn" data-list-id="${l.id}" data-type="personal">Rename</button>
        <button type="button" class="lists-modal-list-item-action lists-modal-list-item-action--delete lists-modal-delete-btn" data-list-id="${l.id}" data-type="personal">Delete</button>
      </div>
    `;
    listEl.appendChild(li);
  });

  sharedLists.forEach((l) => {
    const isOwner = !!(user && l.ownerId && String(l.ownerId) === String(user.uid));
    const li = document.createElement("li");
    li.className = "lists-modal-list-item";
    li.dataset.value = l.id;
    li.dataset.type = "shared";
    li.dataset.count = String((l.items || []).length);
    li.innerHTML = `
      <span class="lists-modal-list-item-name">${iconGroup}<span class="lists-modal-list-item-name-text">${escapeHtml(displayListName(l.name))}</span></span>
      <div class="lists-modal-list-item-actions">
        <button type="button" class="lists-modal-list-item-action lists-modal-rename-btn" data-list-id="${l.id}" data-type="shared">Rename</button>
        ${
          isOwner
            ? `<button type="button" class="lists-modal-list-item-action lists-modal-list-item-action--delete lists-modal-delete-btn" data-list-id="${l.id}" data-type="shared">Delete</button>`
            : `<button type="button" class="lists-modal-list-item-leave lists-modal-leave-btn" data-list-id="${l.id}">Leave</button>`
        }
      </div>
    `;
    listEl.appendChild(li);
  });
}

export function showListsModal() {
  const modal = document.getElementById("lists-modal");
  if (modal) {
    renderListsModalContent();
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
  }
}

export function hideListsModal() {
  const modal = document.getElementById("lists-modal");
  if (modal) {
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
  }
}

/**
 * Ask for a non-empty list name. Resolves trimmed string, or `null` if cancelled (allowCancel).
 */
export function showListNameModal({ title, placeholder = "", initialValue = "", allowCancel = false } = {}) {
  const modal = document.getElementById("list-name-modal");
  const titleEl = document.getElementById("list-name-modal-title");
  const input = document.getElementById("list-name-input");
  const saveBtn = document.getElementById("list-name-save-btn");
  const cancelBtn = document.getElementById("list-name-cancel-btn");
  const errEl = document.getElementById("list-name-error");
  if (!modal || !titleEl || !input || !saveBtn || !errEl) {
    return Promise.reject(new Error("List name modal elements missing"));
  }

  listNameModalAbortController?.abort();
  listNameModalAbortController = new AbortController();
  const ac = listNameModalAbortController;

  if (cancelBtn) {
    cancelBtn.hidden = !allowCancel;
  }

  titleEl.textContent = title || "List name";
  input.value = initialValue ?? "";
  input.placeholder = placeholder || "";
  errEl.hidden = true;
  errEl.textContent = "";

  const closeNameModal = () => {
    ac.abort();
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
    saveBtn.onclick = null;
    if (cancelBtn) cancelBtn.onclick = null;
  };

  input.addEventListener(
    "input",
    () => {
      errEl.hidden = true;
    },
    { signal: ac.signal }
  );
  input.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        saveBtn.click();
      }
    },
    { signal: ac.signal }
  );

  return new Promise((resolve) => {
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
    input.focus();

    if (cancelBtn && allowCancel) {
      cancelBtn.onclick = () => {
        closeNameModal();
        resolve(null);
      };
    }

    saveBtn.onclick = () => {
      const raw = input.value.trim();
      if (!raw) {
        errEl.textContent = "Enter a name.";
        errEl.hidden = false;
        input.focus();
        return;
      }
      closeNameModal();
      resolve(raw);
    };
  });
}

export function showDeleteConfirmModal(listName, count, onConfirm, { isLeave = false, isSharedDelete = false } = {}) {
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

export function hideDeleteConfirmModal() {
  const modal = document.getElementById("delete-confirm-modal");
  if (modal) {
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
  }
  deleteConfirmResolve = null;
}

/** Shared / lists / delete-confirm DOM wiring (call from `init()` after bridge is assigned). */
export function wireListsManagementListeners() {
  document.getElementById("shared-modal-close")?.addEventListener("click", hideSharedModal);
  document.getElementById("shared-modal")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) hideSharedModal();
  });

  document.getElementById("list-settings-btn")?.addEventListener("click", showListsModal);
  document.getElementById("lists-modal-close")?.addEventListener("click", hideListsModal);
  document.getElementById("lists-modal")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) hideListsModal();
  });

  const bookmarkletBtn = document.getElementById("lists-bookmarklet-btn");
  if (bookmarkletBtn) {
    const scriptUrl = window.location.origin + "/bookmarklet.js?v=9";
    bookmarkletBtn.href =
      "javascript:(function(){var s=document.createElement('script');s.src='" + scriptUrl + "';document.body.appendChild(s);})();";
    bookmarkletBtn.addEventListener("click", (e) => {
      e.preventDefault();
    });
  }

  document.getElementById("lists-new-personal-btn")?.addEventListener("click", async () => {
    const user = auth.currentUser;
    if (!user) return;
    const name = await showListNameModal({
      title: "Name your personal list",
      placeholder: "e.g. Weekend picks",
      allowCancel: true,
    });
    if (name == null) return;
    try {
      const listId = await createPersonalList(user.uid, name);
      setPersonalLists(await getPersonalLists(user.uid));
      setCurrentListMode({ type: "personal", listId, name });
      saveLastList(user, currentListMode);
      listHandlerBridge.renderListSelector();
      renderListsModalContent();
      setMovies(await loadList(user));
      listHandlerBridge.syncFiltersAfterListLoad(user);
      setBookmarkletCookie(user);
      const filters = document.getElementById("content-filters");
      if (filters) filters.style.display = movies.length ? "" : "none";
      if (movies.length) {
        listHandlerBridge.buildCards();
        listHandlerBridge.renderGenreFilter();
      } else {
        listHandlerBridge.updateFilterCount(0);
        const grid = document.getElementById("grid");
        if (grid) grid.innerHTML = '<div class="empty-state">Your list is empty. Add titles from <a href="./bookmarklet.html">IMDb</a>.</div>';
      }
      listHandlerBridge.updateCopyInviteButton();
      await listHandlerBridge.afterMoviesReloaded(user);
    } catch (err) {
      alert("Failed to create: " + (err.message || "Unknown error"));
    }
  });

  document.getElementById("lists-create-btn")?.addEventListener("click", async () => {
    const user = auth.currentUser;
    if (!user) return;
    const name = await showListNameModal({
      title: "Name your shared list",
      placeholder: "e.g. Family watchlist",
      allowCancel: true,
    });
    if (name == null) return;
    try {
      const listId = await createSharedList(user.uid, name);
      setSharedLists(await getSharedListsForUser(user.uid));
      setCurrentListMode({ type: "shared", listId, name });
      saveLastList(user, currentListMode);
      listHandlerBridge.renderListSelector();
      renderListsModalContent();
      const shareUrl = window.location.origin + window.location.pathname + "?join=" + listId;
      showSharedModal(
        "Shared list created",
        `
        <p>Share this link for others to join:</p>
        <p class="share-link" id="share-link-text">${shareUrl}</p>
        <button type="button" class="auth-btn" id="copy-share-link-btn" style="margin-top:0.75rem">Copy link</button>
        <p style="margin-top:0.75rem;font-size:0.85rem;color:var(--muted)">Anyone with the link can join. They must be signed in.</p>
      `
      );
      document.getElementById("copy-share-link-btn")?.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(shareUrl);
          const btn = document.getElementById("copy-share-link-btn");
          if (btn) {
            btn.textContent = "Copied!";
            btn.disabled = true;
          }
        } catch (err) {
          alert("Could not copy. Select and copy the link above.");
        }
      });
      setMovies(await loadList(user));
      listHandlerBridge.syncFiltersAfterListLoad(user);
      setBookmarkletCookie(user);
      const filters = document.getElementById("content-filters");
      if (filters) filters.style.display = "";
      listHandlerBridge.buildCards();
      listHandlerBridge.renderGenreFilter();
      listHandlerBridge.updateCopyInviteButton();
      await listHandlerBridge.afterMoviesReloaded(user);
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
        setSharedLists(await getSharedListsForUser(user.uid));
        setCurrentListMode({ type: "shared", listId, name: data.name });
        saveLastList(user, currentListMode);
        listHandlerBridge.renderListSelector();
        renderListsModalContent();
        setMovies(await loadList(user));
        listHandlerBridge.syncFiltersAfterListLoad(user);
        setBookmarkletCookie(user);
        const filters = document.getElementById("content-filters");
        if (filters) filters.style.display = "";
        listHandlerBridge.buildCards();
        listHandlerBridge.renderGenreFilter();
        listHandlerBridge.updateCopyInviteButton();
        await listHandlerBridge.afterMoviesReloaded(user);
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
          setPersonalLists(await getPersonalLists(user.uid));
          setSharedLists(await getSharedListsForUser(user.uid));
          if (typeof currentListMode === "object" && currentListMode?.listId === listId) {
            setCurrentListMode({ ...currentListMode, name: newName });
          }
          listHandlerBridge.renderListSelector();
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

      showDeleteConfirmModal(
        listName,
        count,
        async () => {
          hideDeleteConfirmModal();
          try {
            if (isLeave) {
              await leaveSharedList(user.uid, listId);
            } else {
              const typeInner = li?.dataset.type;
              if (typeInner === "personal") {
                await deletePersonalList(user.uid, listId);
              } else {
                await deleteSharedList(listId);
              }
            }
            setPersonalLists(await getPersonalLists(user.uid));
            setSharedLists(await getSharedListsForUser(user.uid));
            if (typeof currentListMode === "object" && currentListMode?.listId === listId) {
              setCurrentListMode("personal");
              saveLastList(user, currentListMode);
              setMovies(await loadList(user));
              listHandlerBridge.syncFiltersAfterListLoad(user);
              setBookmarkletCookie(user);
              const grid = document.getElementById("grid");
              const filters = document.getElementById("content-filters");
              if (!movies.length) {
                if (filters) filters.style.display = "none";
                listHandlerBridge.updateFilterCount(0);
                if (grid) grid.innerHTML = '<div class="empty-state">Your list is empty. Add titles from <a href="./bookmarklet.html">IMDb</a>.</div>';
              } else {
                if (filters) filters.style.display = "";
                listHandlerBridge.buildCards();
                listHandlerBridge.renderGenreFilter();
              }
              await listHandlerBridge.afterMoviesReloaded(user);
            }
            listHandlerBridge.renderListSelector();
            renderListsModalContent();
            listHandlerBridge.updateCopyInviteButton();
          } catch (err) {
            alert("Failed: " + (err.message || "Unknown error"));
          }
        },
        { isLeave, isSharedDelete: !isLeave && type === "shared" }
      );
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
