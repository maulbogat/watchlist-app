/**
 * One-shot migration: embedded list rows → titleRegistry + `{ registryId }` refs.
 * Status arrays: title|year keys → registry ids where applicable.
 *
 * Usage:
 *   node scripts/migrate-to-title-registry.mjs --dry-run
 *   node scripts/migrate-to-title-registry.mjs
 *
 * Requires FIREBASE_SERVICE_ACCOUNT (base64) or serviceAccountKey.json in project root.
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { registryDocIdFromItem, payloadForRegistry, listKey } from "../lib/registry-id.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const keyPath = join(rootDir, "serviceAccountKey.json");

const dryRun = process.argv.includes("--dry-run");

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
  console.error("Need Firebase credentials (FIREBASE_SERVICE_ACCOUNT or serviceAccountKey.json)");
  process.exit(1);
}

const db = getFirestore(app);

function dedupeItemsByRegistry(items) {
  const seen = new Set();
  const out = [];
  for (const row of items) {
    const id = row?.registryId;
    if (!id) {
      out.push(row);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(row);
  }
  return out;
}

function remapStatus(arr, keyMap) {
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.map((k) => keyMap.get(k) || k))];
}

/**
 * @param {FirebaseFirestore.DocumentReference} ref
 */
async function migrateListDocument(ref) {
  const snap = await ref.get();
  if (!snap.exists) return { updated: false };
  const d = snap.data();
  const items = Array.isArray(d.items) ? d.items : [];
  if (items.length === 0) return { updated: false };

  /** @type {Map<string, string>} */
  const keyMap = new Map();
  const newItems = [];

  for (const m of items) {
    if (!m || typeof m !== "object") continue;
    if (m.registryId && typeof m.registryId === "string") {
      newItems.push({ registryId: m.registryId });
      continue;
    }
    const rid = registryDocIdFromItem(m);
    const oldK = listKey(m);
    keyMap.set(oldK, rid);
    const payload = payloadForRegistry({ ...m, registryId: rid });
    if (!dryRun) {
      await db.collection("titleRegistry").doc(rid).set(payload, { merge: true });
    }
    newItems.push({ registryId: rid });
  }

  const mergedItems = dedupeItemsByRegistry(newItems);
  const watched = remapStatus(d.watched, keyMap);
  const maybeLater = remapStatus(d.maybeLater, keyMap);

  if (!dryRun) {
    const patch = {
      items: mergedItems,
      watched,
      maybeLater,
    };
    if (Array.isArray(d.archive)) patch.archive = remapStatus(d.archive, keyMap);
    await ref.set(patch, { merge: true });
  }
  return { updated: true, path: ref.path, itemCount: mergedItems.length };
}

async function main() {
  console.log(dryRun ? "DRY RUN — no writes" : "LIVE migration");

  let lists = 0;
  const usersSnap = await db.collection("users").get();
  for (const u of usersSnap.docs) {
    const r = await migrateListDocument(u.ref);
    if (r.updated) {
      lists++;
      console.log(`${dryRun ? "[dry-run] " : ""}users/${u.id} items=${r.itemCount}`);
    }
    const plSnap = await db.collection("users").doc(u.id).collection("personalLists").get();
    for (const p of plSnap.docs) {
      const r2 = await migrateListDocument(p.ref);
      if (r2.updated) {
        lists++;
        console.log(`${dryRun ? "[dry-run] " : ""}${p.ref.path} items=${r2.itemCount}`);
      }
    }
  }

  const sharedSnap = await db.collection("sharedLists").get();
  for (const s of sharedSnap.docs) {
    const r = await migrateListDocument(s.ref);
    if (r.updated) {
      lists++;
      console.log(`${dryRun ? "[dry-run] " : ""}${s.ref.path} items=${r.itemCount}`);
    }
  }

  console.log(`Done. Migrated ${lists} list documents.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
