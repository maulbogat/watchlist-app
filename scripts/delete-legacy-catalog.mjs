/**
 * Delete deprecated Firestore catalog documents (collection `catalog`).
 * After migrating to titleRegistry, run once.
 *
 *   node scripts/delete-legacy-catalog.mjs --dry-run
 *   node scripts/delete-legacy-catalog.mjs --write
 *
 * Requires FIREBASE_SERVICE_ACCOUNT or serviceAccountKey.json
 */
import { getDb } from "./lib/admin-init.mjs";

const dryRun = !process.argv.includes("--write");

async function main() {
  const db = getDb();
  const snap = await db.collection("catalog").get();
  if (snap.empty) {
    console.log("No documents in collection `catalog` — nothing to delete.");
    return;
  }
  console.log(dryRun ? "DRY RUN — would delete:\n" : "Deleting:\n");
  for (const d of snap.docs) {
    console.log(`  ${d.ref.path}`);
    if (!dryRun) await d.ref.delete();
  }
  const n = snap.docs.length;
  console.log(dryRun ? `\nPass --write to delete ${n} document(s).` : `\nDeleted ${n} document(s).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
