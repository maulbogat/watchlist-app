/**
 * Query helpers for titleRegistry (replaces old catalog/movies scans).
 */
import { registryDocIdFromItem, listKey } from "../../lib/registry-id.js";

/**
 * @param {import("firebase-admin/firestore").Firestore} db
 * @returns {Promise<Map<string, object>>} id -> { registryId, ...data }
 */
export async function loadAllRegistryMap(db) {
  const snap = await db.collection("titleRegistry").get();
  const map = new Map();
  for (const d of snap.docs) {
    map.set(d.id, { registryId: d.id, ...d.data() });
  }
  return map;
}

/**
 * @param {Map<string, object>} regMap
 * @param {string} title
 * @param {{ exact?: boolean, year?: string|number }} opts
 */
export function findByTitle(regMap, title, opts = {}) {
  const t = String(title || "").trim().toLowerCase();
  const wantYear = opts.year != null && opts.year !== "" ? String(opts.year) : null;
  const out = [];
  for (const m of regMap.values()) {
    const mt = String(m.title || "").trim().toLowerCase();
    if (opts.exact ? mt !== t : !mt.includes(t) && mt !== t) continue;
    if (wantYear != null && String(m.year ?? "") !== wantYear) continue;
    out.push(m);
  }
  return out;
}

/**
 * Hydrate list row: `{ registryId }` or embedded object → full metadata object.
 */
export function hydrateListRow(m, regMap) {
  if (!m || typeof m !== "object") return null;
  if (m.registryId) {
    const full = regMap.get(m.registryId);
    if (full) return { ...full, registryId: m.registryId };
    return { registryId: m.registryId, title: "Unknown" };
  }
  return { ...m, registryId: registryDocIdFromItem(m) };
}

/** Status / dedupe key for a hydrated or embedded row */
export function statusKeyForRow(m) {
  return listKey(m);
}
