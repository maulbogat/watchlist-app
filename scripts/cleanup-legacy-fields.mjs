/**
 * Remove legacy attribution fields from specific `titleRegistry` documents.
 *
 *   node scripts/cleanup-legacy-fields.mjs           # dry run (default)
 *   node scripts/cleanup-legacy-fields.mjs --write
 *
 * Requires: FIREBASE_SERVICE_ACCOUNT (base64) or serviceAccountKey.json (repo root).
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const keyPath = join(rootDir, "serviceAccountKey.json");

const DOC_IDS = ["tt13968792", "tt16431404", "tt32331294", "tt4995790"];

const LEGACY_FIELDS = ["addedByUid", "addedByDisplayName", "addedByPhotoUrl"];

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
} catch {
  console.error("Need Firebase credentials:");
  console.error("  FIREBASE_SERVICE_ACCOUNT (base64) or serviceAccountKey.json in project root.");
  process.exit(1);
}

const db = getFirestore(app);
const col = db.collection("titleRegistry");

for (const id of DOC_IDS) {
  const ref = col.doc(id);
  const snap = await ref.get();
  if (!snap.exists) {
    console.warn(`⚠ skip ${id} — document missing`);
    continue;
  }
  const data = snap.data();
  const title = data?.title ?? id;

  const present = LEGACY_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(data, f));
  if (present.length === 0) {
    console.log(`→ ${title} — nothing to remove`);
    continue;
  }

  const payload = Object.fromEntries(present.map((f) => [f, FieldValue.delete()]));

  if (dryRun) {
    console.log(`[dry-run] ✓ ${title} — would remove fields: ${present.join(", ")}`);
  } else {
    await ref.update(payload);
    console.log(`✓ ${title} — removed fields: ${present.join(", ")}`);
  }
}

if (dryRun) {
  console.log("\nDry run only. Re-run with --write to apply.");
}
