/**
 * Recover titles from Firestore: catalog, sharedLists, and users.
 * Scans all sources and optionally restores to a user's personal list.
 *
 * Run:
 *   node scripts/recover-titles.js                    # Scan and report what's found
 *   node scripts/recover-titles.js --backup           # Write items to watchlist-backup.json
 *   node scripts/recover-titles.js <uid> --restore    # Copy all found items to users/<uid>
 *
 * Requires: serviceAccountKey.json in project root.
 */
import { readFileSync, writeFileSync } from "fs";
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
  console.error("  1. serviceAccountKey.json in project root, or");
  console.error("  2. FIREBASE_SERVICE_ACCOUNT env var (base64 of the JSON)");
  console.error("Get it from Firebase Console → Project Settings → Service Accounts → Generate new key");
  process.exit(1);
}

const db = getFirestore(app);

function movieKey(m) {
  return `${m.title || ""}|${m.year ?? ""}`;
}

function normalizeMovie(m) {
  const { status, ...rest } = m;
  return rest;
}

async function collectFromCatalog() {
  const snap = await db.collection("catalog").doc("movies").get();
  if (!snap.exists) return [];
  const data = snap.data();
  return Array.isArray(data?.items) ? data.items.map(normalizeMovie) : [];
}

async function collectFromSharedLists() {
  const snap = await db.collection("sharedLists").get();
  const all = [];
  snap.docs.forEach((d) => {
    const data = d.data();
    const items = Array.isArray(data?.items) ? data.items : [];
    items.forEach((m) => all.push(normalizeMovie(m)));
  });
  return all;
}

async function collectFromUsers() {
  const snap = await db.collection("users").get();
  const all = [];
  snap.docs.forEach((d) => {
    const data = d.data();
    const items = Array.isArray(data?.items) ? data.items : [];
    items.forEach((m) => all.push(normalizeMovie(m)));
  });
  return all;
}

function mergeUnique(itemsArrays) {
  const seen = new Set();
  const result = [];
  for (const arr of itemsArrays) {
    for (const m of arr) {
      const key = movieKey(m);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(m);
    }
  }
  return result;
}

async function restoreToUser(uid, items) {
  if (items.length === 0) {
    console.error("No items to restore.");
    return;
  }
  const userRef = db.collection("users").doc(uid);
  const snap = await userRef.get();
  const data = snap.exists ? snap.data() : {};
  const existing = Array.isArray(data.items) ? [...data.items] : [];
  const existingKeys = new Set(existing.map((m) => movieKey(m)));
  const watched = new Set(data.watched || []);
  const maybeLater = new Set(data.maybeLater || []);
  const archive = new Set(data.archive || []);

  let added = 0;
  for (const m of items) {
    const key = movieKey(m);
    if (existingKeys.has(key)) continue;
    existing.push(m);
    existingKeys.add(key);
    added++;
  }

  await userRef.set(
    {
      items: existing,
      watched: [...watched],
      maybeLater: [...maybeLater],
      archive: [...archive],
    },
    { merge: true }
  );
  console.log(`Restored ${added} titles to users/${uid}`);
}

async function main() {
  const args = process.argv.slice(2);
  const doBackup = args.includes("--backup");
  const uid = args.find((a) => !a.startsWith("--"));
  const doRestore = args.includes("--restore");

  console.log("Scanning Firestore...\n");

  const [catalog, shared, users] = await Promise.all([
    collectFromCatalog(),
    collectFromSharedLists(),
    collectFromUsers(),
  ]);

  console.log(`Catalog (catalog/movies):     ${catalog.length} items`);
  console.log(`Shared lists:                  ${shared.length} items`);
  console.log(`Users (all):                   ${users.length} items`);

  const merged = mergeUnique([catalog, shared, users]);
  console.log(`\nTotal unique titles found:    ${merged.length}`);

  if (merged.length > 0) {
    console.log("\nFirst 10 titles:");
    merged.slice(0, 10).forEach((m, i) => {
      console.log(`  ${i + 1}. ${m.title} (${m.year ?? "—"})`);
    });
    if (merged.length > 10) {
      console.log(`  ... and ${merged.length - 10} more`);
    }
  }

  if (doBackup && merged.length > 0) {
    const backupPath = join(rootDir, "watchlist-backup.json");
    const backup = {
      exportedAt: new Date().toISOString(),
      count: merged.length,
      items: merged,
    };
    writeFileSync(backupPath, JSON.stringify(backup, null, 2), "utf-8");
    console.log(`\nBackup written to ${backupPath}`);
  }

  if (doRestore && uid) {
    console.log(`\nRestoring to users/${uid}...`);
    await restoreToUser(uid, merged);
    console.log("Done.");
  } else if (doRestore && !uid) {
    console.error("\nUsage: node scripts/recover-titles.js <uid> --restore");
    console.error("Get your UID from Firebase Console → Authentication → Users, or run: node scripts/list-users.js");
  } else if (merged.length > 0 && !doRestore && !doBackup) {
    console.log("\nOptions:");
    console.log("  node scripts/recover-titles.js --backup           # Save to watchlist-backup.json");
    console.log("  node scripts/recover-titles.js <your-uid> --restore");
    console.log("\nGet your UID: node scripts/list-users.js");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
