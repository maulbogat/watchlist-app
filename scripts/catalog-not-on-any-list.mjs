/**
 * Find titleRegistry documents that are not referenced by any list row (registryId).
 * Legacy embedded rows (no registryId) are ignored — they are not catalog docs.
 *
 * Run: node scripts/catalog-not-on-any-list.mjs
 * Requires: serviceAccountKey.json or FIREBASE_SERVICE_ACCOUNT (base64), same as other scripts.
 */
import { getDb } from "./lib/admin-init.mjs";

/** @param {unknown} items */
function collectRegistryIdsFromItems(items) {
  const ids = new Set();
  if (!Array.isArray(items)) return ids;
  for (const row of items) {
    if (row && typeof row === "object" && row.registryId != null && String(row.registryId).trim()) {
      ids.add(String(row.registryId).trim());
    }
  }
  return ids;
}

async function run() {
  const db = getDb();
  /** @type {Set<string>} */
  const referenced = new Set();

  console.log("Scanning sharedLists…");
  const slSnap = await db.collection("sharedLists").get();
  for (const d of slSnap.docs) {
    const data = d.data();
    for (const id of collectRegistryIdsFromItems(data.items)) referenced.add(id);
  }
  console.log(`  ${slSnap.size} shared list docs`);

  console.log("Scanning users/*/personalLists…");
  const usersSnap = await db.collection("users").get();
  let plDocs = 0;
  for (const u of usersSnap.docs) {
    const plSnap = await u.ref.collection("personalLists").get();
    plDocs += plSnap.size;
    for (const d of plSnap.docs) {
      for (const id of collectRegistryIdsFromItems(d.data().items)) referenced.add(id);
    }
    const ud = u.data();
    if (Array.isArray(ud.items)) {
      for (const id of collectRegistryIdsFromItems(ud.items)) referenced.add(id);
    }
  }
  console.log(`  ${usersSnap.size} users, ${plDocs} personalLists subdocs`);

  console.log("Loading titleRegistry ids…");
  const trSnap = await db.collection("titleRegistry").select().get();
  const allIds = trSnap.docs.map((d) => d.id);
  const allSet = new Set(allIds);

  const notOnAnyList = allIds.filter((id) => !referenced.has(id));

  console.log("\n=== Result ===\n");
  console.log(`titleRegistry docs:     ${allIds.length}`);
  console.log(`Referenced on a list:   ${referenced.size} distinct registryIds`);
  console.log(`Not on any list:        ${notOnAnyList.length}`);

  if (notOnAnyList.length === 0) {
    console.log("\nNo orphaned catalog rows (every titleRegistry doc appears on at least one list).");
    return;
  }

  console.log("\n--- Orphaned registry ids (sample up to 50) ---\n");
  const sample = notOnAnyList.slice(0, 50);
  for (const id of sample) {
    console.log(`  ${id}`);
  }
  if (notOnAnyList.length > 50) {
    console.log(`  … and ${notOnAnyList.length - 50} more`);
  }

  const refsNotInRegistry = [...referenced].filter((id) => !allSet.has(id));
  if (refsNotInRegistry.length > 0) {
    console.log(
      `\nNote: ${refsNotInRegistry.length} list row(s) reference registryId not present in titleRegistry (stale refs).`
    );
    console.log("Sample:", refsNotInRegistry.slice(0, 10).join(", "));
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
