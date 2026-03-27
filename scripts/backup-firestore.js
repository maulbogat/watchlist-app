/**
 * Full Firestore backup: titleRegistry, upcomingAlerts (optional),
 * sharedLists, users (top-level), allowedUsers, invites, phoneIndex,
 * upcomingChecks, and users/{uid}/personalLists.
 * (Deprecated `catalog` collection is not exported.)
 *
 * Run:
 *   node scripts/backup-firestore.js [output-path]
 *   node scripts/backup-firestore.js --no-alerts   # skip upcomingAlerts (can be large)
 *   node scripts/backup-firestore.js backups/my-export.json --no-alerts
 *
 * Output defaults to backups/firestore-backup.json
 *
 * Requires: FIREBASE_SERVICE_ACCOUNT env var (base64 of service account JSON)
 *   or serviceAccountKey.json in project root.
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

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

/** JSON-safe values (Timestamps → ISO, GeoPoint → {latitude,longitude}, etc.) */
function serializeFirestoreValue(v) {
  if (v == null) return v;
  if (v instanceof Timestamp) return v.toDate().toISOString();
  if (typeof v.toDate === "function" && !(v instanceof Date)) {
    try {
      return v.toDate().toISOString();
    } catch {
      /* ignore */
    }
  }
  if (v && typeof v === "object" && v.constructor?.name === "GeoPoint") {
    return { __geo__: true, latitude: v.latitude, longitude: v.longitude };
  }
  if (Array.isArray(v)) return v.map(serializeFirestoreValue);
  if (Buffer.isBuffer(v)) return v.toString("base64");
  if (v && typeof v === "object") {
    if (v.constructor?.name === "DocumentReference") {
      return { __ref__: v.path };
    }
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = serializeFirestoreValue(x);
    return o;
  }
  return v;
}

function serializeDoc(doc) {
  const data = doc.data();
  if (!data) return null;
  const plain = {};
  for (const [k, v] of Object.entries(data)) plain[k] = serializeFirestoreValue(v);
  return { id: doc.id, ...plain };
}

async function backupCollection(name) {
  const snap = await db.collection(name).get();
  const out = {};
  snap.docs.forEach((d) => {
    out[d.id] = serializeDoc(d);
  });
  return out;
}

async function backupUserPersonalLists(userIds) {
  const out = {};
  for (const uid of userIds) {
    const plSnap = await db.collection("users").doc(uid).collection("personalLists").get();
    if (plSnap.empty) continue;
    const lists = {};
    plSnap.docs.forEach((d) => {
      lists[d.id] = serializeDoc(d);
    });
    out[uid] = lists;
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const noAlerts = args.includes("--no-alerts");
  const outputPath =
    args.find((a) => !a.startsWith("--")) || join(rootDir, "backups", "firestore-backup.json");

  console.log("Backing up Firestore...");

  const [titleRegistry, sharedLists, users, allowedUsers, invites, phoneIndex, upcomingChecks] =
    await Promise.all([
      backupCollection("titleRegistry"),
      backupCollection("sharedLists"),
      backupCollection("users"),
      backupCollection("allowedUsers"),
      backupCollection("invites"),
      backupCollection("phoneIndex"),
      backupCollection("upcomingChecks"),
    ]);

  const userIds = Object.keys(users);
  const userPersonalLists = await backupUserPersonalLists(userIds);

  let upcomingAlerts = {};
  if (!noAlerts) {
    upcomingAlerts = await backupCollection("upcomingAlerts");
  }

  const backup = {
    exportedAt: new Date().toISOString(),
    version: 4,
    titleRegistry,
    upcomingAlerts,
    sharedLists,
    users,
    userPersonalLists,
    allowedUsers,
    invites,
    phoneIndex,
    upcomingChecks,
  };

  mkdirSync(join(rootDir, "backups"), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(backup, null, 2), "utf-8");

  const trCount = Object.keys(titleRegistry).length;
  const alertCount = Object.keys(upcomingAlerts).length;
  const plUsers = Object.keys(userPersonalLists).length;
  const plLists = Object.values(userPersonalLists).reduce((n, m) => n + Object.keys(m).length, 0);

  console.log(`  titleRegistry:  ${trCount} docs`);
  console.log(`  upcomingAlerts: ${noAlerts ? "(skipped)" : `${alertCount} docs`}`);
  console.log(`  sharedLists:    ${Object.keys(sharedLists).length} docs`);
  console.log(`  users:          ${userIds.length} docs`);
  console.log(`  allowedUsers:   ${Object.keys(allowedUsers).length} docs`);
  console.log(`  invites:        ${Object.keys(invites).length} docs`);
  console.log(`  phoneIndex:     ${Object.keys(phoneIndex).length} docs`);
  console.log(`  upcomingChecks: ${Object.keys(upcomingChecks).length} docs`);
  console.log(`  personalLists:  ${plLists} lists across ${plUsers} users`);
  console.log(`\nBackup written to ${outputPath}`);
  console.log("\nSearch the file, e.g.:  rg 'tt15677150|136311|Shrinking' " + outputPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
