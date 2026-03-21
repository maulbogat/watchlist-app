/**
 * Hydrate list rows from a v3 backup JSON (titleRegistry map + user/shared items).
 */
import { listKey, registryDocIdFromItem } from "../../lib/registry-id.js";

/** @returns {Record<string, object>} registryId -> full row */
export function trMapFromBackup(backup) {
  const tr = backup.titleRegistry || {};
  const out = {};
  for (const [id, row] of Object.entries(tr)) {
    if (!row || typeof row !== "object") continue;
    const { id: _docId, ...rest } = row;
    out[id] = { registryId: id, ...rest };
  }
  return out;
}

export function hydrateBackupRow(m, trMap) {
  if (!m || typeof m !== "object") return null;
  if (m.registryId) {
    const full = trMap[m.registryId];
    if (full) return { ...full };
    return { registryId: m.registryId, title: "Unknown" };
  }
  return { ...m, registryId: registryDocIdFromItem(m) };
}

export function backupListKey(m, trMap) {
  return listKey(hydrateBackupRow(m, trMap));
}
