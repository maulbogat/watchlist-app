#!/usr/bin/env node
/**
 * Remove favorites for any "to-watch" item across all personal and shared lists.
 *
 * An item is "to-watch" if its key is NOT in the list's `watched` array.
 * Favorites are stored as `favorites.{registryId}: true` on the list doc.
 *
 * Usage:
 *   node scripts/fix-favorites-to-watch.mjs           # dry run
 *   node scripts/fix-favorites-to-watch.mjs --write   # apply changes
 */
import "dotenv/config";
import { createRequire } from "module";
import { FieldValue } from "firebase-admin/firestore";
import { getDb } from "./lib/admin-init.mjs";

const require = createRequire(import.meta.url);
const { listKey } = require("../src/api-lib/registry-id.cjs");

async function main() {
  const write = process.argv.includes("--write");
  console.log(write ? "MODE: WRITE" : "MODE: dry-run (pass --write to apply)");

  const db = getDb();
  let totalFixed = 0;

  // ── Personal lists ────────────────────────────────────────────────────────
  console.log("\n=== Personal lists ===");
  const usersSnap = await db.collection("users").get();
  for (const userDoc of usersSnap.docs) {
    const uid = userDoc.id;
    const plSnap = await userDoc.ref.collection("personalLists").get();
    for (const plDoc of plSnap.docs) {
      const data = plDoc.data() || {};
      const favorites = data.favorites;
      if (!favorites || typeof favorites !== "object" || Array.isArray(favorites)) continue;
      const favKeys = Object.keys(favorites);
      if (favKeys.length === 0) continue;

      const watched = new Set(Array.isArray(data.watched) ? data.watched : []);
      const toRemove = favKeys.filter((k) => !watched.has(k));
      if (toRemove.length === 0) continue;

      console.log(`  ${plDoc.ref.path}:`);
      for (const k of toRemove) {
        console.log(`    remove favorites.${k} (to-watch)`);
      }
      totalFixed += toRemove.length;

      if (write) {
        const updates = {};
        for (const k of toRemove) updates[`favorites.${k}`] = FieldValue.delete();
        await plDoc.ref.update(updates);
      }
    }
  }

  // ── Shared lists ──────────────────────────────────────────────────────────
  console.log("\n=== Shared lists ===");
  const sharedSnap = await db.collection("sharedLists").get();
  for (const slDoc of sharedSnap.docs) {
    const data = slDoc.data() || {};
    const favorites = data.favorites;
    if (!favorites || typeof favorites !== "object" || Array.isArray(favorites)) continue;
    const favKeys = Object.keys(favorites);
    if (favKeys.length === 0) continue;

    const watched = new Set(Array.isArray(data.watched) ? data.watched : []);
    const toRemove = favKeys.filter((k) => !watched.has(k));
    if (toRemove.length === 0) continue;

    console.log(`  ${slDoc.ref.path}:`);
    for (const k of toRemove) {
      console.log(`    remove favorites.${k} (to-watch)`);
    }
    totalFixed += toRemove.length;

    if (write) {
      const updates = {};
      for (const k of toRemove) updates[`favorites.${k}`] = FieldValue.delete();
      await slDoc.ref.update(updates);
    }
  }

  console.log(
    write
      ? `\nDone. Removed ${totalFixed} favorite(s) from to-watch items.`
      : `\nDry run complete. Would remove ${totalFixed} favorite(s). Pass --write to apply.`
  );
}

main().catch((err) => {
  console.error("Fatal:", err.message || err);
  process.exit(1);
});
