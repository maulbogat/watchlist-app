import { displayListName } from "./utils.js";

/**
 * Human label for the active list (header / trailer modal), matching legacy `getCurrentListLabel`.
 * @param {unknown} mode — Zustand list mode (`"personal"` or `{ type, listId, name? }`)
 * @param {any[]} personalLists
 * @param {any[]} sharedLists
 */
export function getListLabel(mode, personalLists, sharedLists) {
  if (mode === "personal") {
    const p = personalLists.find((l) => l.id === "personal");
    return displayListName(p?.name);
  }
  if (mode && typeof mode === "object" && mode.type === "personal") {
    const p = personalLists.find((l) => l.id === mode.listId);
    return displayListName(p?.name ?? mode.name);
  }
  if (mode && typeof mode === "object" && mode.type === "shared") {
    return displayListName(mode.name);
  }
  const main = personalLists.find((l) => l.id === "personal");
  return displayListName(main?.name);
}
