/**
 * Find titleRegistry documents that are not referenced by any list row (registryId).
 * Legacy embedded rows (no registryId) are ignored — they are not catalog docs.
 *
 * Run: node scripts/catalog-not-on-any-list.mjs
 * Requires: serviceAccountKey.json or FIREBASE_SERVICE_ACCOUNT (base64), same as other scripts.
 */
import { createRequire } from "module";
import { getDb } from "./lib/admin-init.mjs";

const require = createRequire(import.meta.url);
const { scanCatalogOrphanIds } = require("../src/api-lib/catalog-orphan-scan.cjs");

async function run() {
  const db = getDb();

  console.log("Scanning sharedLists, users/*/personalLists, legacy users.items…");
  const {
    orphanIds: notOnAnyList,
    allRegistryIds,
    referencedIds,
    registryDocCount,
    referencedDistinctCount,
  } = await scanCatalogOrphanIds(db);
  const allSet = new Set(allRegistryIds);

  console.log("\n=== Result ===\n");
  console.log(`titleRegistry docs:     ${registryDocCount}`);
  console.log(`Referenced on a list:   ${referencedDistinctCount} distinct registryIds`);
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

  const refsNotInRegistry = referencedIds.filter((id) => !allSet.has(id));
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
