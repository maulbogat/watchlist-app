/**
 * Remove `addedByDisplayName` and `addedByPhotoUrl` from each `sharedLists/{id}.items[]` row.
 * Canonical profile data lives on `users/{uid}` only; the app merges by `addedByUid` in one batch.
 *
 * Usage:
 *   node scripts/strip-shared-list-denormalized-attribution.mjs --dry-run
 *   node scripts/strip-shared-list-denormalized-attribution.mjs --write
 *   node scripts/strip-shared-list-denormalized-attribution.mjs --write --listId <sharedListId>
 */
import { getDb } from "./lib/admin-init.mjs";

const dryRun = !process.argv.includes("--write");
const listArg = process.argv.indexOf("--listId");
const onlyListId =
  listArg !== -1 && process.argv[listArg + 1] ? process.argv[listArg + 1].trim() : null;

const db = getDb();

function stripRow(row) {
  if (!row || typeof row !== "object") return { row, changed: false };
  if (!("addedByDisplayName" in row) && !("addedByPhotoUrl" in row)) return { row, changed: false };
  const o = { ...row };
  delete o.addedByDisplayName;
  delete o.addedByPhotoUrl;
  return { row: o, changed: true };
}

async function processList(doc) {
  const listId = doc.id;
  const data = doc.data();
  const items = Array.isArray(data.items) ? data.items : [];
  let changed = 0;
  const next = items.map((row) => {
    const { row: out, changed: c } = stripRow(row);
    if (c) changed++;
    return out;
  });
  if (!dryRun && changed > 0) {
    await db.collection("sharedLists").doc(listId).set({ items: next }, { merge: true });
  }
  return { listId, name: data.name || "", itemCount: items.length, rowsStripped: changed };
}

async function main() {
  let listsSnap;
  if (onlyListId) {
    const d = await db.collection("sharedLists").doc(onlyListId).get();
    if (!d.exists) {
      console.error(`sharedLists/${onlyListId} not found`);
      process.exit(1);
    }
    listsSnap = { docs: [d] };
  } else {
    listsSnap = await db.collection("sharedLists").get();
  }

  let total = 0;
  for (const doc of listsSnap.docs) {
    const r = await processList(doc);
    if (r.rowsStripped > 0) {
      total += r.rowsStripped;
      console.log(
        `${dryRun ? "[dry-run] " : ""}${r.listId} "${r.name}" — stripped ${r.rowsStripped} row(s) (${r.itemCount} items)`
      );
    }
  }
  console.log(`\nDone (${dryRun ? "dry-run" : "write"}). Rows touched: ${total}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
