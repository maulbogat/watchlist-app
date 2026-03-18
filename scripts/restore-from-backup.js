/**
 * Restore Firestore from a backup created by backup-firestore.js.
 *
 * Run: node scripts/restore-from-backup.js [backup-file]
 * Default: backups/firestore-backup.json
 *
 * WARNING: This overwrites existing data. Use with caution.
 * Add --dry-run to preview without writing.
 *
 * Requires: FIREBASE_SERVICE_ACCOUNT env var or serviceAccountKey.json
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const keyPath = join(rootDir, "serviceAccountKey.json");

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
  console.error("Need Firebase credentials. See backup-firestore.js for setup.");
  process.exit(1);
}

const db = getFirestore(app);

async function restoreCollection(name, docs, dryRun) {
  const col = db.collection(name);
  let count = 0;
  for (const [docId, data] of Object.entries(docs)) {
    if (!data || data.id === undefined) continue;
    const { id, ...rest } = data;
    if (dryRun) {
      console.log(`  [dry-run] ${name}/${docId}`);
      count++;
    } else {
      await col.doc(docId).set(rest, { merge: true });
      count++;
    }
  }
  return count;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const backupPath = args.find((a) => !a.startsWith("--")) || join(rootDir, "backups", "firestore-backup.json");

  let backup;
  try {
    backup = JSON.parse(readFileSync(backupPath, "utf-8"));
  } catch (e) {
    console.error(`Cannot read backup: ${backupPath}`);
    process.exit(1);
  }

  console.log(`Restoring from ${backupPath} (exported ${backup.exportedAt})`);
  if (dryRun) console.log("DRY RUN - no changes will be written\n");

  const [catalogCount, sharedCount, userCount] = await Promise.all([
    restoreCollection("catalog", backup.catalog || {}, dryRun),
    restoreCollection("sharedLists", backup.sharedLists || {}, dryRun),
    restoreCollection("users", backup.users || {}, dryRun),
  ]);

  console.log(`\nRestored: catalog=${catalogCount}, sharedLists=${sharedCount}, users=${userCount}`);
  if (dryRun) console.log("\nRun without --dry-run to apply changes.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
