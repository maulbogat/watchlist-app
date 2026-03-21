/**
 * Backup JSON helpers: titleRegistry is stored as { [registryId]: { id, ...fields } }.
 */
import { registryDocIdFromItem, payloadForRegistry } from "../../lib/registry-id.js";

export function titleRegistryToArray(backup) {
  const tr = backup.titleRegistry || {};
  return Object.entries(tr)
    .map(([id, row]) => {
      if (!row || typeof row !== "object") return null;
      const { id: _i, ...rest } = row;
      return { registryId: id, ...rest };
    })
    .filter(Boolean);
}

export function titleRegistryFromArray(items) {
  const out = {};
  for (const m of items) {
    if (!m || typeof m !== "object") continue;
    const rid = m.registryId || registryDocIdFromItem(m);
    const payload = payloadForRegistry({ ...m, registryId: rid });
    out[rid] = { id: rid, ...payload };
  }
  return out;
}

/** Mutate backup.titleRegistry from an array mutator fn(items) => newItems */
export function mutateTitleRegistryInBackup(backup, mutator) {
  let items = titleRegistryToArray(backup);
  items = mutator(items) ?? items;
  backup.titleRegistry = titleRegistryFromArray(items);
}
