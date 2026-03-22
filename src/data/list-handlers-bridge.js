/**
 * Filled by app.js immediately before init() so src/data/lists.js can call UI
 * without importing app.js (avoids circular dependencies).
 */
export const listHandlerBridge = {
  syncFiltersAfterListLoad: null,
  buildCards: null,
  renderGenreFilter: null,
  updateFilterCount: null,
  updateCopyInviteButton: null,
  afterMoviesReloaded: null,
  renderListSelector: null,
  openModal: null,
  closeModal: null,
  updateModalStatusBtn: null,
};
