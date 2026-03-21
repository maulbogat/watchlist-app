/**
 * Update year on a titleRegistry doc. If doc id changes (legacy hash), rewrites list references.
 * Run: node scripts/update-year.js "Title" 2024
 */
import { getDb } from "./lib/admin-init.mjs";
import { loadAllRegistryMap, findByTitle } from "./lib/registry-query.mjs";
import { registryDocIdFromItem, payloadForRegistry } from "../lib/registry-id.js";
import { rewriteRegistryIdEverywhere } from "./lib/rewrite-registry-id.mjs";

async function main() {
  const [, , title, year] = process.argv;
  if (!title || year === undefined) {
    console.error('Usage: node scripts/update-year.js "Title" year');
    process.exit(1);
  }

  const db = getDb();
  const regMap = await loadAllRegistryMap(db);
  const hits = findByTitle(regMap, title, { exact: true });
  if (hits.length === 0) {
    console.error(`"${title}" not found in titleRegistry.`);
    process.exit(1);
  }
  if (hits.length > 1) {
    console.error("Ambiguous title:", hits.map((h) => `${h.title} (${h.year})`).join(", "));
    process.exit(1);
  }
  const cur = hits[0];
  const oldId = cur.registryId;
  const y = Number(year) || null;
  const merged = { ...cur, year: y };
  const newId = registryDocIdFromItem(merged);
  const payload = payloadForRegistry({ ...merged, registryId: newId });

  if (newId === oldId) {
    await db.collection("titleRegistry").doc(oldId).set({ year: y }, { merge: true });
    console.log(`Updated titleRegistry/${oldId} year → ${y}`);
  } else {
    await db.collection("titleRegistry").doc(newId).set(payload, { merge: true });
    await rewriteRegistryIdEverywhere(db, oldId, newId);
    await db.collection("titleRegistry").doc(oldId).delete();
    console.log(`Moved titleRegistry ${oldId} → ${newId} (year ${y})`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
