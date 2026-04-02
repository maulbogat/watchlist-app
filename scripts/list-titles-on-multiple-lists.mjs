/**
 * Print registryIds that appear on more than one list (sharedLists or personalLists),
 * plus legacy users.{uid}.items rows. Each distinct list doc counts once per title.
 *
 * Run: node scripts/list-titles-on-multiple-lists.mjs
 * Requires: serviceAccountKey.json or FIREBASE_SERVICE_ACCOUNT (base64).
 */
import { createRequire } from "module";
import { getDb } from "./lib/admin-init.mjs";

const require = createRequire(import.meta.url);
const { collectRegistryIdsFromItems } = require("../src/api-lib/catalog-orphan-scan.cjs");

/** @param {Map<string, Set<string>>} map */
function addRefs(map, listPath, items) {
  for (const id of collectRegistryIdsFromItems(items)) {
    let set = map.get(id);
    if (!set) {
      set = new Set();
      map.set(id, set);
    }
    set.add(listPath);
  }
}

async function run() {
  const db = getDb();
  /** @type {Map<string, Set<string>>} */
  const registryToLists = new Map();

  const slSnap = await db.collection("sharedLists").get();
  for (const d of slSnap.docs) {
    addRefs(registryToLists, `sharedLists/${d.id}`, d.data().items);
  }

  const usersSnap = await db.collection("users").get();
  for (const u of usersSnap.docs) {
    const plSnap = await u.ref.collection("personalLists").get();
    for (const d of plSnap.docs) {
      addRefs(registryToLists, `users/${u.id}/personalLists/${d.id}`, d.data().items);
    }
    const ud = u.data();
    if (Array.isArray(ud.items)) {
      addRefs(registryToLists, `users/${u.id}#legacy-root-items`, ud.items);
    }
  }

  const multi = [...registryToLists.entries()]
    .filter(([, paths]) => paths.size > 1)
    .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]));

  console.log(`Titles on more than one list: ${multi.length}\n`);

  for (const [registryId, paths] of multi) {
    console.log(`${registryId}`);
    for (const p of [...paths].sort()) {
      console.log(`  - ${p}`);
    }
    console.log("");
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
