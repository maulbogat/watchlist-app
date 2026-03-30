#!/usr/bin/env node
/**
 * Delete the legacy `archive` array field from list documents (removed from the app).
 * Touches: `sharedLists` docs and `users/{uid}/personalLists` docs.
 *
 * After running, titles that were only in `archive` behave as **To Watch** (still in `items`,
 * no longer in any status array).
 *
 *   node -r dotenv/config scripts/strip-archive-field.mjs --dry-run
 *   node -r dotenv/config scripts/strip-archive-field.mjs --write
 */
import "dotenv/config";
import { FieldValue } from "firebase-admin/firestore";
import { getDb } from "./lib/admin-init.mjs";

const dryRun = !process.argv.includes("--write");

async function stripArchiveFromRef(ref, label) {
  const snap = await ref.get();
  if (!snap.exists) return 0;
  const data = snap.data();
  if (!Object.prototype.hasOwnProperty.call(data, "archive")) return 0;
  const n = Array.isArray(data.archive) ? data.archive.length : "(non-array)";
  console.log(`${dryRun ? "[dry-run] " : ""}${label} — archive field (${n} entries)`);
  if (!dryRun) {
    await ref.update({ archive: FieldValue.delete() });
  }
  return 1;
}

async function main() {
  console.log(
    dryRun
      ? "DRY RUN (no writes). Pass --write to delete `archive` from list docs.\n"
      : "Deleting `archive` fields…\n"
  );

  let touched = 0;
  const db = getDb();

  const sharedSnap = await db.collection("sharedLists").get();
  for (const d of sharedSnap.docs) {
    touched += await stripArchiveFromRef(d.ref, `sharedLists/${d.id}`);
  }

  const usersSnap = await db.collection("users").get();
  for (const d of usersSnap.docs) {
    const plSnap = await db.collection("users").doc(d.id).collection("personalLists").get();
    for (const p of plSnap.docs) {
      touched += await stripArchiveFromRef(p.ref, `users/${d.id}/personalLists/${p.id}`);
    }
  }

  console.log(`\nDone. Documents ${dryRun ? "that would be updated" : "updated"}: ${touched}`);
  if (dryRun) console.log("\nRun: node -r dotenv/config scripts/strip-archive-field.mjs --write");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
