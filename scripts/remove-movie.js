/**
 * Remove a title: delete titleRegistry doc and remove refs from all lists / status arrays.
 * Run: node scripts/remove-movie.js "Title" [year]
 */
import { getDb } from "./lib/admin-init.mjs";
import { findByTitle } from "./lib/registry-query.mjs";
import { listKey } from "../lib/registry-id.js";

function matchesLegacyRow(m, title, year) {
  if (!m || m.registryId) return false;
  if (String(m.title || "").toLowerCase() !== String(title).toLowerCase()) return false;
  if (year == null || year === "") return true;
  return String(m.year ?? "") === String(year);
}

async function loadRegMap(db) {
  const snap = await db.collection("titleRegistry").get();
  const map = new Map();
  for (const d of snap.docs) map.set(d.id, { registryId: d.id, ...d.data() });
  return map;
}

async function purgeFromDocument(ref, data, registryIds, matches, title, year) {
  const items = Array.isArray(data.items) ? data.items : [];
  const ridSet = new Set(registryIds);
  const statusKeysToRemove = new Set(registryIds);
  for (const m of matches) statusKeysToRemove.add(listKey(m));
  if (matches.length === 0) statusKeysToRemove.add(listKey({ title, year: year ?? "" }));
  const newItems = items.filter((m) => {
    if (!m) return true;
    if (m.registryId && ridSet.has(m.registryId)) return false;
    if (matchesLegacyRow(m, title, year)) return false;
    return true;
  });
  const strip = (arr) => (Array.isArray(arr) ? arr : []).filter((k) => !statusKeysToRemove.has(k));
  const watched = strip(data.watched);
  const maybeLater = strip(data.maybeLater);
  const archive = strip(data.archive);
  const changed =
    newItems.length !== items.length ||
    watched.length !== (data.watched || []).length ||
    maybeLater.length !== (data.maybeLater || []).length ||
    archive.length !== (data.archive || []).length;
  if (changed) {
    await ref.set({ items: newItems, watched, maybeLater, archive }, { merge: true });
  }
}

async function main() {
  const db = getDb();
  const [, , title, year] = process.argv;
  if (!title) {
    console.error('Usage: node scripts/remove-movie.js "Title" [year]');
    process.exit(1);
  }
  const regMap = await loadRegMap(db);
  const matches = findByTitle(regMap, title, { exact: true, year });
  const registryIds = matches.map((m) => m.registryId);
  if (matches.length === 0) {
    console.warn(
      `No titleRegistry doc for "${title}"${year != null ? ` (${year})` : ""} — removing legacy list rows / status keys only.`
    );
  } else {
    for (const rid of registryIds) {
      await db.collection("titleRegistry").doc(rid).delete();
      console.log(`Deleted titleRegistry/${rid}`);
    }
  }

  const us = await db.collection("users").get();
  for (const d of us.docs) {
    await purgeFromDocument(d.ref, d.data(), registryIds, matches, title, year);
    const pl = await d.ref.collection("personalLists").get();
    for (const p of pl.docs) await purgeFromDocument(p.ref, p.data(), registryIds, matches, title, year);
  }
  const sh = await db.collection("sharedLists").get();
  for (const d of sh.docs) await purgeFromDocument(d.ref, d.data(), registryIds, matches, title, year);

  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
