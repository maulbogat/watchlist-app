#!/usr/bin/env node
/**
 * Ensure the 42 titles that were attributed to Keshet on **Our list** (pre-consolidate backup,
 * 2026-04-02) are present on the shared list named like **Our list**, with **`addedByUid`** /
 * **`addedByDisplayName`** / **`addedByPhotoUrl`** set from Keshet’s Firebase Auth + **`users`** doc.
 *
 * - Rows already on the list are updated in place (order preserved).
 * - Missing **`registryId`**s are appended with a fresh **`addedAt`**.
 * - Does not change **`watched`** / **`maybeLater`** / **`archive`** on the shared list.
 *
 * Optional **`--removeFromMyList`**: after updating the shared list, remove those **`registryId`**s
 * from the personal **My list** doc for **`WATCHLIST_MY_LIST_UID`** (**`items`** and status arrays),
 * using **`scripts/lib/resolve-my-list-ref.mjs`** (same resolution as other maintenance scripts).
 *
 * Usage:
 *   node -r dotenv/config scripts/ensure-keshet-titles-on-our-list.mjs --dry-run
 *   node -r dotenv/config scripts/ensure-keshet-titles-on-our-list.mjs --write
 *   node -r dotenv/config scripts/ensure-keshet-titles-on-our-list.mjs --write --removeFromMyList
 *   node -r dotenv/config scripts/ensure-keshet-titles-on-our-list.mjs --write --listName "Our list"
 *
 * Requires: **`FIREBASE_SERVICE_ACCOUNT`** (base64) or **`serviceAccountKey.json`**.
 */
import "dotenv/config";
import { getAuth } from "firebase-admin/auth";
import { getDb } from "./lib/admin-init.mjs";
import { loadAllRegistryMap } from "./lib/registry-query.mjs";
import { resolveMyListPersonalRef } from "./lib/resolve-my-list-ref.mjs";
import { listKey } from "../lib/registry-id.js";

/** Keshet (see `scripts/seed-allowed-users.mjs`). */
const KESHET_UID = "TaCuVF6CUCRmC86BBYI5uxSXmvG2";

/** From `backups/pre-consolidate-my-list-2026-04-02T17-24-14-832Z.json` (Our list / Keshet rows). */
const KESHET_REGISTRY_IDS = [
  "tt0104348",
  "tt0128442",
  "tt0260866",
  "tt0382625",
  "tt0387808",
  "tt11173006",
  "tt11691774",
  "tt12042730",
  "tt1245492",
  "tt12966558",
  "tt13567480",
  "tt13911628",
  "tt13968792",
  "tt14271498",
  "tt14364480",
  "tt1538403",
  "tt15469618",
  "tt16744184",
  "tt17543592",
  "tt18988144",
  "tt21433690",
  "tt22202452",
  "tt22746676",
  "tt24509990",
  "tt27502523",
  "tt27543632",
  "tt27995114",
  "tt30955673",
  "tt31938062",
  "tt32267726",
  "tt32420734",
  "tt33362589",
  "tt33612209",
  "tt3868832",
  "tt39635096",
  "tt40197357",
  "tt4995790",
  "tt5875444",
  "tt7445308",
  "tt7569576",
  "tt8694364",
  "tt9278304",
];

function parseArgs(argv) {
  const dryRun = !argv.includes("--write");
  const removeFromMyList = argv.includes("--removeFromMyList");
  const nameIdx = argv.indexOf("--listName");
  const listName =
    nameIdx !== -1 && argv[nameIdx + 1] ? String(argv[nameIdx + 1]).trim() : "Our list";
  return { dryRun, removeFromMyList, listName };
}

async function resolveSharedListId(db, name) {
  const snap = await db.collection("sharedLists").get();
  const lower = name.toLowerCase().trim();
  const match = snap.docs.find((d) => {
    const n = String(d.data().name || "").toLowerCase().trim();
    return n === lower || n.includes(lower) || lower.includes(n);
  });
  if (!match) throw new Error(`No shared list found matching "${name}"`);
  return { id: match.id, name: match.data().name || "" };
}

async function profileForUid(db, auth, uid) {
  const snap = await db.collection("users").doc(uid).get();
  let displayName = "";
  let photoURL = "";
  if (snap.exists) {
    const d = snap.data();
    if (typeof d.displayName === "string" && d.displayName.trim()) displayName = d.displayName.trim();
    if (typeof d.photoURL === "string" && d.photoURL.trim()) photoURL = d.photoURL.trim();
  }
  try {
    const u = await auth.getUser(uid);
    if (!displayName && u.displayName && String(u.displayName).trim()) displayName = String(u.displayName).trim();
    if (!photoURL && u.photoURL && String(u.photoURL).trim()) photoURL = String(u.photoURL).trim();
  } catch {
    /* missing auth user */
  }
  return { displayName, photoURL };
}

function keshetRow(base, profile) {
  const row = {
    ...base,
    addedByUid: KESHET_UID,
  };
  if (profile.displayName) row.addedByDisplayName = profile.displayName;
  else delete row.addedByDisplayName;
  if (profile.photoURL) row.addedByPhotoUrl = profile.photoURL;
  else delete row.addedByPhotoUrl;
  return row;
}

async function main() {
  const { dryRun, removeFromMyList, listName } = parseArgs(process.argv.slice(2));
  if (removeFromMyList && !(process.env.WATCHLIST_MY_LIST_UID || "").trim()) {
    console.error("--removeFromMyList requires WATCHLIST_MY_LIST_UID (set in .env or the shell).");
    process.exit(1);
  }

  const db = getDb();
  const auth = getAuth();

  const wanted = new Set(KESHET_REGISTRY_IDS);
  if (wanted.size !== 42) {
    throw new Error(`Expected 42 registry ids, got ${wanted.size}`);
  }

  const regMap = await loadAllRegistryMap(db);
  const missingReg = [...wanted].filter((id) => !regMap.has(id));
  if (missingReg.length > 0) {
    console.warn(
      "Warning: these registryIds are not in titleRegistry yet (rows will still be added/updated):",
      missingReg.join(", ")
    );
  }

  const { id: sharedId, name: resolvedName } = await resolveSharedListId(db, listName);
  const ref = db.collection("sharedLists").doc(sharedId);
  const listSnap = await ref.get();
  if (!listSnap.exists) throw new Error(`sharedLists/${sharedId} missing`);
  const data = listSnap.data();
  const items = Array.isArray(data.items) ? [...data.items] : [];

  const profile = await profileForUid(db, auth, KESHET_UID);
  console.log(
    `Keshet profile: displayName=${profile.displayName || "(empty)"} photoURL=${profile.photoURL ? "yes" : "no"}`
  );
  console.log(`Target: sharedLists/${sharedId} "${resolvedName}" (${dryRun ? "dry-run" : "write"})`);

  let updatedInPlace = 0;
  let appended = 0;
  const next = items.map((row) => {
    if (!row || typeof row !== "object") return row;
    const key = listKey(row);
    if (!key || !wanted.has(key)) return row;
    updatedInPlace++;
    return keshetRow(row, profile);
  });

  const keysNow = new Set(next.map((r) => (r && typeof r === "object" ? listKey(r) : "")).filter(Boolean));
  const iso = new Date().toISOString();
  for (const rid of KESHET_REGISTRY_IDS) {
    if (keysNow.has(rid)) continue;
    next.push(
      keshetRow({ registryId: rid, addedAt: iso }, profile)
    );
    keysNow.add(rid);
    appended++;
    console.log(`${dryRun ? "[dry-run] Would append" : "Append"} ${rid}`);
  }

  if (updatedInPlace > 0) {
    console.log(
      `${dryRun ? "[dry-run] Would update" : "Updated"} ${updatedInPlace} existing row(s) with Keshet attribution`
    );
  }

  if (!dryRun && (updatedInPlace > 0 || appended > 0)) {
    await ref.set({ items: next }, { merge: true });
  }

  if (removeFromMyList) {
    const uid = (process.env.WATCHLIST_MY_LIST_UID || "").trim();
    const plRef = await resolveMyListPersonalRef(db, uid);
    const plSnap = await plRef.get();
    if (!plSnap.exists) throw new Error(`${plRef.path} not found`);
    const pl = plSnap.data();
    const plItems = Array.isArray(pl.items) ? [...pl.items] : [];
    const before = plItems.length;
    const filteredItems = plItems.filter((row) => {
      const k = row && typeof row === "object" ? listKey(row) : "";
      return !k || !wanted.has(k);
    });
    const filterArr = (arr) =>
      Array.isArray(arr) ? arr.filter((k) => !wanted.has(String(k))) : [];

    const removed = before - filteredItems.length;
    const w = filterArr(pl.watched);
    const m = filterArr(pl.maybeLater);
    const a = filterArr(pl.archive);

    console.log(
      `${dryRun ? "[dry-run] Would remove" : "Remove"} ${removed} item(s) from ${plRef.path} (and strip from status arrays)`
    );

    if (!dryRun && (removed > 0 || JSON.stringify(w) !== JSON.stringify(pl.watched || []) ||
      JSON.stringify(m) !== JSON.stringify(pl.maybeLater || []) ||
      JSON.stringify(a) !== JSON.stringify(pl.archive || []))) {
      await plRef.set(
        {
          items: filteredItems,
          watched: w,
          maybeLater: m,
          archive: a,
        },
        { merge: true }
      );
    }
  }

  console.log(`\nDone (${dryRun ? "dry-run" : "write"}). Updated in place: ${updatedInPlace}, appended: ${appended}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
