import { COUNTRIES } from "../../countries.js";
import { userCountryCode } from "../store/state.js";
import { escapeHtml } from "../lib/utils.js";

let countryModalAbortController = null;

export function showCountryModal({ initialCode = "IL", onSave } = {}) {
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
    const filtered = q ? COUNTRIES.filter((c) => c.searchKey.includes(q)) : COUNTRIES;
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

export function hideCountryModal() {
  const modal = document.getElementById("country-modal");
  if (modal) {
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
  }
}

export function updateCountryDropdownRow() {
  const btn = document.getElementById("auth-country-btn");
  if (!btn) return;
  const c = COUNTRIES.find((x) => x.code === userCountryCode);
  btn.textContent = `Country: ${c ? c.flag + " " + c.name : userCountryCode}`;
}
