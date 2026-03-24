/**
 * Print shared list item rows + users/{addedByUid} profile fields (what the app merges for avatars).
 * Uses Firebase Admin — hits your real Firestore project (same as production when using the same key).
 *
 * Usage:
 *   node scripts/check-shared-list-attribution.mjs <sharedListId>
 *   node scripts/check-shared-list-attribution.mjs <sharedListId> <registryId>
 *
 * Requires: serviceAccountKey.json at repo root, or FIREBASE_SERVICE_ACCOUNT (base64 JSON).
 */
import { getDb } from "./lib/admin-init.mjs";

const listId = process.argv[2];
const registryFilter = process.argv[3]?.trim() || null;

if (!listId) {
  console.error("Usage: node scripts/check-shared-list-attribution.mjs <sharedListId> [registryId]");
  process.exit(1);
}

const db = getDb();
const listSnap = await db.collection("sharedLists").doc(listId).get();
if (!listSnap.exists) {
  console.error(`sharedLists/${listId} not found.`);
  process.exit(1);
}

const items = Array.isArray(listSnap.data().items) ? listSnap.data().items : [];
const rows = registryFilter ? items.filter((r) => r && String(r.registryId) === registryFilter) : items;

if (rows.length === 0) {
  console.log(registryFilter ? `No row with registryId=${registryFilter}` : "No items on this list.");
  process.exit(0);
}

const uids = [...new Set(rows.map((r) => (typeof r.addedByUid === "string" ? r.addedByUid : null)).filter(Boolean))];
const userSnaps = await Promise.all(uids.map((uid) => db.collection("users").doc(uid).get()));
const userByUid = new Map();
uids.forEach((uid, i) => {
  const s = userSnaps[i];
  userByUid.set(uid, s.exists ? s.data() : null);
});

for (const row of rows) {
  const rid = row?.registryId != null ? String(row.registryId) : "";
  const uid = typeof row.addedByUid === "string" ? row.addedByUid : null;
  const ud = uid ? userByUid.get(uid) : null;
  const dn = ud && typeof ud.displayName === "string" ? ud.displayName.trim() : "";
  const photo = ud && typeof ud.photoURL === "string" && ud.photoURL.trim() ? ud.photoURL.trim() : "";
  console.log("---");
  console.log(`registryId: ${rid || "(none)"}`);
  console.log(`addedByUid: ${uid || "(missing — UI will show ? and skip merge)"}`);
  console.log(`users/{uid}.displayName: ${dn || "(empty — merge will not set addedByDisplayName)"}`);
  console.log(`users/{uid}.photoURL: ${photo ? photo.slice(0, 72) + (photo.length > 72 ? "…" : "") : "(empty — no photo in Firestore)"}`);
  console.log(
    `merge would hydrate: ${uid && (dn || photo) ? "yes (displayName and/or photo for TitleCard)" : "partial or no"}`
  );
}

console.log(`\nDone. ${rows.length} row(s). List name: ${listSnap.data().name || ""}`);
