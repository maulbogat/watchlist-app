/**
 * Delete the legacy `removed` array field from Firestore (unused by the app).
 * Touches: sharedLists docs, users root docs, and users/{uid}/personalLists docs.
 *
 *   node scripts/strip-removed-field.js --dry-run
 *   node scripts/strip-removed-field.js --write
 *
 * Requires: FIREBASE_SERVICE_ACCOUNT or serviceAccountKey.json
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const keyPath = join(rootDir, "serviceAccountKey.json");

const args = process.argv.slice(2);
const dryRun = !args.includes("--write");

let app;
try {
  let key;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    key = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, "base64").toString("utf-8"));
  } else {
    key = JSON.parse(readFileSync(keyPath, "utf-8"));
  }
  app = initializeApp({ credential: cert(key) });
} catch (e) {
  console.error("Need Firebase credentials (see scripts/backup-firestore.js).");
  process.exit(1);
}

const db = getFirestore(app);

async function stripRemovedFromRef(ref, label) {
  const snap = await ref.get();
  if (!snap.exists) return 0;
  const data = snap.data();
  if (!Object.prototype.hasOwnProperty.call(data, "removed")) return 0;
  const n = Array.isArray(data.removed) ? data.removed.length : "(non-array)";
  console.log(`${dryRun ? "[dry-run] " : ""}${label} — removed field (${n} entries)`);
  if (!dryRun) {
    await ref.update({ removed: FieldValue.delete() });
  }
  return 1;
}

async function main() {
  console.log(dryRun ? "DRY RUN (no writes). Pass --write to delete `removed`.\n" : "Deleting `removed` fields…\n");

  let touched = 0;

  const sharedSnap = await db.collection("sharedLists").get();
  for (const d of sharedSnap.docs) {
    touched += await stripRemovedFromRef(d.ref, `sharedLists/${d.id}`);
  }

  const usersSnap = await db.collection("users").get();
  for (const d of usersSnap.docs) {
    touched += await stripRemovedFromRef(d.ref, `users/${d.id}`);
    const plSnap = await db.collection("users").doc(d.id).collection("personalLists").get();
    for (const p of plSnap.docs) {
      touched += await stripRemovedFromRef(p.ref, `users/${d.id}/personalLists/${p.id}`);
    }
  }

  console.log(`\nDone. Documents ${dryRun ? "that would be updated" : "updated"}: ${touched}`);
  if (dryRun) console.log("\nRun: node scripts/strip-removed-field.js --write");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
