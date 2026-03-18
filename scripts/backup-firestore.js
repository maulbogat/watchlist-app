/**
 * Full Firestore backup: exports catalog, sharedLists, and users.
 * Used by GitHub Actions daily backup job.
 *
 * Run: node scripts/backup-firestore.js [output-path]
 * Output defaults to backups/firestore-backup.json
 *
 * Requires: FIREBASE_SERVICE_ACCOUNT env var (base64 of service account JSON)
 *   or serviceAccountKey.json in project root.
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
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
  console.error("Need Firebase credentials:");
  console.error("  1. FIREBASE_SERVICE_ACCOUNT env var (base64 of service account JSON), or");
  console.error("  2. serviceAccountKey.json in project root");
  console.error("Get it from Firebase Console → Project Settings → Service Accounts → Generate new key");
  process.exit(1);
}

const db = getFirestore(app);

function serializeDoc(doc) {
  const data = doc.data();
  if (!data) return null;
  return { id: doc.id, ...data };
}

async function backupCollection(name) {
  const snap = await db.collection(name).get();
  const out = {};
  snap.docs.forEach((d) => {
    out[d.id] = serializeDoc(d);
  });
  return out;
}

async function main() {
  const outputPath = process.argv[2] || join(rootDir, "backups", "firestore-backup.json");

  console.log("Backing up Firestore...");

  const [catalog, sharedLists, users] = await Promise.all([
    backupCollection("catalog"),
    backupCollection("sharedLists"),
    backupCollection("users"),
  ]);

  const backup = {
    exportedAt: new Date().toISOString(),
    catalog,
    sharedLists,
    users,
  };

  mkdirSync(join(rootDir, "backups"), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(backup, null, 2), "utf-8");

  const catalogCount = Object.keys(catalog).length;
  const sharedCount = Object.keys(sharedLists).length;
  const userCount = Object.keys(users).length;
  console.log(`  catalog:     ${catalogCount} docs`);
  console.log(`  sharedLists: ${sharedCount} docs`);
  console.log(`  users:       ${userCount} docs`);
  console.log(`\nBackup written to ${outputPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
