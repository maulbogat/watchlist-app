/**
 * Rename a title in titleRegistry. If doc id changes (legacy hash), rewrites list references.
 * Run: node scripts/rename-movie.js "Old Title" "New Title"
 */
import { getDb } from "./lib/admin-init.mjs";
import { loadAllRegistryMap, findByTitle } from "./lib/registry-query.mjs";
import { registryDocIdFromItem, payloadForRegistry } from "../lib/registry-id.js";
import { rewriteRegistryIdEverywhere } from "./lib/rewrite-registry-id.mjs";

async function main() {
  const [, , oldTitle, newTitle] = process.argv;
  if (!oldTitle || !newTitle) {
    console.error('Usage: node scripts/rename-movie.js "Old Title" "New Title"');
    process.exit(1);
  }

  const db = getDb();
  const regMap = await loadAllRegistryMap(db);
  const hits = findByTitle(regMap, oldTitle, { exact: true });
  if (hits.length === 0) {
    console.error(`"${oldTitle}" not found in titleRegistry.`);
    process.exit(1);
  }
  if (hits.length > 1) {
    console.error("Ambiguous old title:", hits.map((h) => `${h.title} (${h.year})`).join(", "));
    process.exit(1);
  }
  const cur = hits[0];
  const oldId = cur.registryId;
  const merged = { ...cur, title: newTitle };
  const newId = registryDocIdFromItem(merged);
  const payload = payloadForRegistry({ ...merged, registryId: newId });

  if (newId === oldId) {
    await db.collection("titleRegistry").doc(oldId).set({ title: newTitle }, { merge: true });
    console.log(`Renamed titleRegistry/${oldId} → "${newTitle}"`);
  } else {
    await db.collection("titleRegistry").doc(newId).set(payload, { merge: true });
    await rewriteRegistryIdEverywhere(db, oldId, newId);
    await db.collection("titleRegistry").doc(oldId).delete();
    console.log(`Moved titleRegistry ${oldId} → ${newId}, title "${newTitle}"`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
