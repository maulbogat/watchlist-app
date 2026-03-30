#!/usr/bin/env node
/**
 * Put every title on a shared list on the "To Watch" tab: keep `items` unchanged and clear
 * `watched` and `maybeLater` (those arrays drive Watched / maybe-later state).
 *
 * Usage:
 *   node -r dotenv/config scripts/reset-shared-list-all-to-watch.mjs --dry-run "Our list"
 *   node -r dotenv/config scripts/reset-shared-list-all-to-watch.mjs --write "Our list"
 *
 * List name is matched like other scripts (substring / case-insensitive).
 */
import "dotenv/config";
import { FieldValue } from "firebase-admin/firestore";
import { getDb } from "./lib/admin-init.mjs";

function parseArgs() {
  const argv = process.argv.slice(2);
  const write = argv.includes("--write");
  const positional = argv.filter((a) => !a.startsWith("--"));
  const listName = positional[0] || "Our list";
  return { write, listName };
}

async function resolveSharedListId(db, name) {
  const snap = await db.collection("sharedLists").get();
  const lower = name.toLowerCase().trim();
  const match = snap.docs.find((d) => {
    const n = String(d.data().name || "").toLowerCase().trim();
    return n === lower || n.includes(lower) || lower.includes(n);
  });
  if (!match) throw new Error(`No shared list found matching "${name}"`);
  return { id: match.id, name: match.data().name || "", data: match.data() };
}

async function main() {
  const { write, listName } = parseArgs();
  const db = getDb();
  const { id, name, data } = await resolveSharedListId(db, listName);
  const items = Array.isArray(data.items) ? data.items : [];
  const w = Array.isArray(data.watched) ? data.watched : [];
  const m = Array.isArray(data.maybeLater) ? data.maybeLater : [];
  const a = Array.isArray(data.archive) ? data.archive : [];

  console.log(`Shared list: "${name}" (${id})`);
  console.log(`  items: ${items.length}`);
  console.log(`  watched: ${w.length}, maybeLater: ${m.length}${a.length ? `, legacy archive keys: ${a.length} (field removed on write)` : ""}`);
  console.log(write ? "MODE: WRITE" : "MODE: dry-run (pass --write to apply)");

  if (!write) return;

  await db.collection("sharedLists").doc(id).set(
    {
      watched: [],
      maybeLater: [],
      archive: FieldValue.delete(),
    },
    { merge: true }
  );

  console.log("Done: all list rows are now on the To Watch tab (status arrays cleared).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
