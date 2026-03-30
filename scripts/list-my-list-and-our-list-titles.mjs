#!/usr/bin/env node
/**
 * Print every distinct catalog title that appears on **My list** (one user’s default personal list)
 * **or** on the shared list whose name matches “Our list” (same name heuristic as
 * `scripts/audit-candidates-vs-our-list.mjs`). Hydrates labels from `titleRegistry`.
 *
 * Does **not** change the Admin UI — run locally with Admin credentials.
 *
 *   node -r dotenv/config scripts/list-my-list-and-our-list-titles.mjs
 *
 * Env:
 *   - `WATCHLIST_MY_LIST_UID` (required) — Firebase Auth `uid` whose `users/{uid}.defaultPersonalListId`
 *     personal list is “My list” (or the first `personalLists` doc named like “my list” if default id missing).
 *   - `FIREBASE_SERVICE_ACCOUNT` (base64) or `serviceAccountKey.json` in project root.
 *
 * Writes: `backups/my-list-and-our-list-titles.txt` (plus stdout).
 */
import "dotenv/config";
import { createRequire } from "module";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { FieldPath } from "firebase-admin/firestore";
import { getDb } from "./lib/admin-init.mjs";

const require = createRequire(import.meta.url);
const { collectRegistryIdsFromItems } = require("../src/api-lib/catalog-orphan-scan.cjs");

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(__dirname, "..", "backups", "my-list-and-our-list-titles.txt");

function normName(s) {
  return String(s || "")
    .trim()
    .toLowerCase();
}

/**
 * @param {import("firebase-admin/firestore").Firestore} db
 * @param {string[]} ids
 */
async function hydrateTitles(db, ids) {
  const unique = [...new Set(ids)].sort();
  /** @type {Map<string, { title: string; year: string | number | null }>} */
  const map = new Map();
  const chunkSize = 30;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const snap = await db
      .collection("titleRegistry")
      .where(FieldPath.documentId(), "in", chunk)
      .select("title", "year")
      .get();
    const seen = new Set();
    for (const d of snap.docs) {
      seen.add(d.id);
      const x = d.data() || {};
      const title =
        typeof x.title === "string" && x.title.trim() !== "" ? x.title.trim() : d.id;
      const year = x.year != null && x.year !== "" ? x.year : null;
      map.set(d.id, { title, year });
    }
    for (const id of chunk) {
      if (!seen.has(id)) map.set(id, { title: id, year: null });
    }
  }
  return map;
}

function formatLine(registryId, title, year) {
  const y = year != null && year !== "" ? String(year) : "—";
  return `${registryId} · ${title} (${y})`;
}

async function main() {
  const uid = (process.env.WATCHLIST_MY_LIST_UID || "").trim();
  if (!uid) {
    console.error("Set WATCHLIST_MY_LIST_UID to your Firebase Auth uid (owner of My list).");
    process.exit(1);
  }

  const db = getDb();

  const uref = db.collection("users").doc(uid);
  const uSnap = await uref.get();
  if (!uSnap.exists) {
    console.error(`users/${uid} does not exist.`);
    process.exit(1);
  }
  const udata = uSnap.data() || {};
  let myListRef = null;
  const defaultId =
    typeof udata.defaultPersonalListId === "string" ? udata.defaultPersonalListId.trim() : "";
  if (defaultId) {
    myListRef = uref.collection("personalLists").doc(defaultId);
  } else {
    const plSnap = await uref.collection("personalLists").get();
    const hit = plSnap.docs.find((d) => {
      const n = normName(d.data()?.name);
      return n === "my list" || n.includes("my list");
    });
    if (hit) myListRef = hit.ref;
  }
  if (!myListRef) {
    console.error(
      "Could not resolve My list: set users.defaultPersonalListId or name a personal list “My list”."
    );
    process.exit(1);
  }
  const myListSnap = await myListRef.get();
  if (!myListSnap.exists) {
    console.error("Personal list document missing:", myListRef.path);
    process.exit(1);
  }
  const myItems = myListSnap.data()?.items;
  const myIds = [...collectRegistryIdsFromItems(myItems)];

  const slSnap = await db.collection("sharedLists").get();
  const ourDoc = slSnap.docs.find((d) => {
    const n = normName(d.data()?.name);
    return n.includes("our list") || n === "our list";
  });
  if (!ourDoc) {
    console.error('No shared list with a name matching "Our list".');
    process.exit(1);
  }
  const ourIds = [...collectRegistryIdsFromItems(ourDoc.data()?.items)];

  const union = new Set([...myIds, ...ourIds]);
  const map = await hydrateTitles(db, [...union]);

  const lines = [...union]
    .map((id) => {
      const h = map.get(id) || { title: id, year: null };
      return { id, line: formatLine(id, h.title, h.year), sortTitle: normName(h.title) };
    })
    .sort((a, b) => {
      const c = a.sortTitle.localeCompare(b.sortTitle);
      return c !== 0 ? c : a.id.localeCompare(b.id);
    })
    .map((x) => x.line);

  const header = [
    `# My list + Our list — ${new Date().toISOString()}`,
    `# uid=${uid}  myList=${myListRef.path}  ourList=${ourDoc.ref.path}`,
    `# distinct titles: ${lines.length}`,
    "",
  ];
  const body = header.join("\n") + lines.join("\n") + "\n";

  console.log(body);
  const dir = dirname(outPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(outPath, body, "utf8");
  console.error(`Wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
