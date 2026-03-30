#!/usr/bin/env node
/**
 * Move every title on **My list** that appears on the **To Watch** tab (not Watched, not already Archive)
 * into **Archive**: merge keys into `personalLists.{id}.archive` and set `titleRegistry.{key}.listStatus`
 * to `archive` (same keys the client uses via `listKey`).
 *
 *   node -r dotenv/config scripts/move-my-list-to-watch-to-archive.mjs           # dry-run
 *   node -r dotenv/config scripts/move-my-list-to-watch-to-archive.mjs --write   # apply
 *
 * Env: `WATCHLIST_MY_LIST_UID`, optional `WATCHLIST_PERSONAL_LIST_ID` (Firestore id of the
 * `personalLists` doc when it is not the one named “My list”), `FIREBASE_SERVICE_ACCOUNT` or
 * `serviceAccountKey.json`.
 *
 * Resolution order: explicit **`WATCHLIST_PERSONAL_LIST_ID`** → personal list whose **name** is
 * “My list” (matches the **MY LIST** selector in the app) → **`defaultPersonalListId`**. If your
 * default list is another name (e.g. “Survival”) but you still use a list named “My list”, the
 * script targets **“My list”**, not the default.
 */
import "dotenv/config";
import { createRequire } from "module";
import { getDb } from "./lib/admin-init.mjs";
import { resolveMyListPersonalRef } from "./lib/resolve-my-list-ref.mjs";

const require = createRequire(import.meta.url);
const { listKey } = require("../src/api-lib/registry-id.cjs");

async function main() {
  const write = process.argv.includes("--write");
  const uid = (process.env.WATCHLIST_MY_LIST_UID || "").trim();
  if (!uid) {
    console.error("Set WATCHLIST_MY_LIST_UID to your Firebase Auth uid.");
    process.exit(1);
  }

  const db = getDb();
  const listRef = await resolveMyListPersonalRef(db, uid);
  const snap = await listRef.get();
  if (!snap.exists) {
    console.error("Personal list document missing:", listRef.path);
    process.exit(1);
  }

  const data = snap.data() || {};
  const rawItems = Array.isArray(data.items) ? data.items : [];
  const watched = new Set((Array.isArray(data.watched) ? data.watched : []).map((k) => String(k)));
  const maybeLater = new Set(
    (Array.isArray(data.maybeLater) ? data.maybeLater : []).map((k) => String(k))
  );
  const existingArchive = new Set(
    (Array.isArray(data.archive) ? data.archive : []).map((k) => String(k))
  );

  /** To Watch tab = not watched, not archived (includes maybe-later). */
  const toArchiveKeys = new Set();
  for (const row of rawItems) {
    if (!row || typeof row !== "object") continue;
    const k = listKey(row);
    if (!k) continue;
    if (watched.has(k) || existingArchive.has(k)) continue;
    toArchiveKeys.add(k);
  }

  const keys = [...toArchiveKeys].sort();
  console.log(`List path: ${listRef.path}`);
  console.log(`Items: ${rawItems.length}, watched: ${watched.size}, maybeLater: ${maybeLater.size}, already archived: ${existingArchive.size}`);
  console.log(`Keys to move to Archive (To Watch tab): ${keys.length}`);
  if (keys.length <= 50) {
    for (const k of keys) console.log(`  - ${k}`);
  } else {
    keys.slice(0, 20).forEach((k) => console.log(`  - ${k}`));
    console.log(`  ... and ${keys.length - 20} more`);
  }

  if (!write) {
    console.log("\nDry run. Pass --write to apply.");
    return;
  }

  const newArchive = [...new Set([...existingArchive, ...keys])];

  await listRef.set({ archive: newArchive }, { merge: true });
  console.log(`\n✓ Updated ${listRef.path} archive (${newArchive.length} total keys)`);

  let batch = db.batch();
  let n = 0;
  for (const k of keys) {
    batch.set(db.collection("titleRegistry").doc(k), { listStatus: "archive" }, { merge: true });
    n++;
    if (n >= 400) {
      await batch.commit();
      batch = db.batch();
      n = 0;
    }
  }
  if (n > 0) await batch.commit();
  console.log(`✓ titleRegistry listStatus=archive for ${keys.length} keys (batch commits OK)`);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
