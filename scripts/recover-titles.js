/**
 * Recover titles from Firestore: titleRegistry + all list rows (users, sharedLists, personalLists).
 *
 * Run:
 *   node scripts/recover-titles.js                    # Scan and report
 *   node scripts/recover-titles.js --backup           # watchlist-backup.json
 *   node scripts/recover-titles.js <uid> --restore    # Merge into users/{uid}
 *
 * Requires: serviceAccountKey.json or FIREBASE_SERVICE_ACCOUNT
 */
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { getDb } from "./lib/admin-init.mjs";
import { hydrateListRow } from "./lib/registry-query.mjs";
import { registryDocIdFromItem, payloadForRegistry, listKey } from "../lib/registry-id.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

async function loadRegMap(db) {
  const snap = await db.collection("titleRegistry").get();
  const map = new Map();
  for (const d of snap.docs) map.set(d.id, { registryId: d.id, ...d.data() });
  return map;
}

function normalizeHydrated(m) {
  const { status, ...rest } = m;
  return rest;
}

async function collectFromRegistry(db) {
  const map = await loadRegMap(db);
  return [...map.values()].map(normalizeHydrated);
}

async function collectFromListDocs(db, regMap) {
  const out = [];

  function pushFromItems(items) {
    if (!Array.isArray(items)) return;
    for (const m of items) {
      const h = hydrateListRow(m, regMap);
      if (h) out.push(normalizeHydrated(h));
    }
  }

  const us = await db.collection("users").get();
  for (const d of us.docs) {
    pushFromItems(d.data().items);
    const pl = await d.ref.collection("personalLists").get();
    for (const p of pl.docs) pushFromItems(p.data().items);
  }
  const sh = await db.collection("sharedLists").get();
  for (const d of sh.docs) pushFromItems(d.data().items);
  return out;
}

function mergeUnique(items) {
  const seen = new Set();
  const result = [];
  for (const m of items) {
    const k = m.registryId || listKey(m);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    result.push(m);
  }
  return result;
}

async function restoreToUser(db, uid, items) {
  if (items.length === 0) {
    console.error("No items to restore.");
    return;
  }
  const userRef = db.collection("users").doc(uid);
  const snap = await userRef.get();
  const data = snap.exists ? snap.data() : {};
  const existing = Array.isArray(data.items) ? [...data.items] : [];
  const existingKeys = new Set(existing.map((m) => (m.registryId ? m.registryId : listKey(m))));
  const watched = new Set(data.watched || []);
  const maybeLater = new Set(data.maybeLater || []);

  let added = 0;
  for (const m of items) {
    const rid = m.registryId || registryDocIdFromItem(m);
    const key = rid;
    if (existingKeys.has(key)) continue;
    const payload = payloadForRegistry({ ...m, registryId: rid });
    await db.collection("titleRegistry").doc(rid).set(payload, { merge: true });
    existing.push({ registryId: rid });
    existingKeys.add(key);
    added++;
  }

  await userRef.set(
    {
      items: existing,
      watched: [...watched],
      maybeLater: [...maybeLater],
    },
    { merge: true }
  );
  console.log(`Restored ${added} titles to users/${uid} (titleRegistry + { registryId } rows)`);
}

async function main() {
  const db = getDb();
  const args = process.argv.slice(2);
  const doBackup = args.includes("--backup");
  const uid = args.find((a) => !a.startsWith("--"));
  const doRestore = args.includes("--restore");

  console.log("Scanning Firestore...\n");

  const regMap = await loadRegMap(db);
  const [fromReg, fromLists] = await Promise.all([collectFromRegistry(db), collectFromListDocs(db, regMap)]);

  console.log(`titleRegistry docs:           ${fromReg.length}`);
  console.log(`List rows (hydrated):         ${fromLists.length}`);

  const merged = mergeUnique([...fromReg, ...fromLists]);
  console.log(`\nTotal unique titles:         ${merged.length}`);

  if (merged.length > 0) {
    console.log("\nFirst 10 titles:");
    merged.slice(0, 10).forEach((m, i) => {
      console.log(`  ${i + 1}. ${m.title || m.registryId} (${m.year ?? "—"})  [${m.registryId || listKey(m)}]`);
    });
    if (merged.length > 10) console.log(`  ... and ${merged.length - 10} more`);
  }

  if (doBackup && merged.length > 0) {
    const backupPath = join(rootDir, "watchlist-backup.json");
    writeFileSync(
      backupPath,
      JSON.stringify({ exportedAt: new Date().toISOString(), count: merged.length, items: merged }, null, 2),
      "utf-8"
    );
    console.log(`\nBackup written to ${backupPath}`);
  }

  if (doRestore && uid) {
    console.log(`\nRestoring to users/${uid}...`);
    await restoreToUser(db, uid, merged);
    console.log("Done.");
  } else if (doRestore && !uid) {
    console.error("\nUsage: node scripts/recover-titles.js <uid> --restore");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
