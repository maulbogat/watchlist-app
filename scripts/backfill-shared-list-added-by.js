/**
 * Sets `addedByUid` on every row in `sharedLists/{listId}.items` (display names live on `users/{uid}.displayName`).
 *
 * Usage:
 *   node scripts/backfill-shared-list-added-by.js <listId> <firebaseAuthUid>
 *
 * After running, ensure each member has signed in once (or set `users/{uid}.displayName` in console).
 *
 * Requires: `serviceAccountKey.json` at repo root.
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

const [, , listId, uid] = process.argv;

if (!listId || !uid) {
  console.error("Usage: node scripts/backfill-shared-list-added-by.js <listId> <firebaseAuthUid>");
  process.exit(1);
}

const key = JSON.parse(readFileSync(join(rootDir, "serviceAccountKey.json"), "utf-8"));
const app = initializeApp({ credential: cert(key) });
const db = getFirestore(app);

const ref = db.collection("sharedLists").doc(listId);
const snap = await ref.get();
if (!snap.exists) {
  console.error(`sharedLists/${listId} not found.`);
  process.exit(1);
}

const data = snap.data();
const items = Array.isArray(data.items) ? [...data.items] : [];
if (items.length === 0) {
  console.log("No items to update.");
  process.exit(0);
}

const next = items.map((row) => {
  if (!row || typeof row !== "object") return row;
  return { ...row, addedByUid: uid };
});

await ref.set({ items: next }, { merge: true });
console.log(`Updated ${next.length} item row(s) on sharedLists/${listId} with addedByUid=${uid} (keeps existing addedByDisplayName/addedByPhotoUrl on rows).`);
