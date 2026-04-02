#!/usr/bin/env node
/**
 * Consolidate every title from this user’s personal lists (and optionally shared lists they
 * belong to) into the **My list** personal doc, each on the **To Watch** tab: one merged
 * `items` array, empty `watched` / `maybeLater`, `archive` cleared. Other personal lists are
 * emptied; optional shared lists are emptied when `--include-shared` is set.
 *
 * Before any `--write`, writes a JSON snapshot of affected docs under `backups/`.
 *
 *   node -r dotenv/config scripts/consolidate-all-titles-to-my-list-to-watch.mjs
 *   node -r dotenv/config scripts/consolidate-all-titles-to-my-list-to-watch.mjs --write
 *   node -r dotenv/config scripts/consolidate-all-titles-to-my-list-to-watch.mjs --write --include-shared
 *
 * Env: `WATCHLIST_MY_LIST_UID` (required), optional `WATCHLIST_PERSONAL_LIST_ID`,
 * `FIREBASE_SERVICE_ACCOUNT` or `serviceAccountKey.json`.
 */
import "dotenv/config";
import { createRequire } from "module";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { FieldPath, FieldValue, Timestamp } from "firebase-admin/firestore";
import { getDb } from "./lib/admin-init.mjs";
import { resolveMyListPersonalRef } from "./lib/resolve-my-list-ref.mjs";

const require = createRequire(import.meta.url);
const { listKey } = require("../src/api-lib/registry-id.cjs");

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

/** @param {unknown} v */
function jsonSafe(v) {
  if (v == null) return v;
  if (v instanceof Timestamp) return v.toDate().toISOString();
  if (typeof v?.toDate === "function") {
    try {
      return v.toDate().toISOString();
    } catch {
      /* ignore */
    }
  }
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = jsonSafe(x);
    return o;
  }
  return v;
}

/** @param {import("firebase-admin/firestore").DocumentSnapshot} snap */
function docPayload(snap) {
  if (!snap.exists) return null;
  return { id: snap.id, path: snap.ref.path, data: jsonSafe(snap.data()) };
}

/**
 * @param {Record<string, unknown> | null | undefined} prev
 * @param {Record<string, unknown> | null | undefined} next
 */
function pickBetterRow(prev, next) {
  if (!prev) return next;
  if (!next) return prev;
  const pReg = prev.registryId != null && String(prev.registryId).trim();
  const nReg = next.registryId != null && String(next.registryId).trim();
  if (nReg && !pReg) return next;
  return prev;
}

/**
 * @param {import("firebase-admin/firestore").Firestore} db
 * @param {Set<string>} ids
 */
async function fetchRegistryRows(db, ids) {
  /** @type {Map<string, Record<string, unknown>>} */
  const out = new Map();
  const unique = [...ids].filter(Boolean);
  const chunkSize = 30;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const snap = await db
      .collection("titleRegistry")
      .where(FieldPath.documentId(), "in", chunk)
      .get();
    for (const d of snap.docs) out.set(d.id, d.data() || {});
  }
  return out;
}

/**
 * @param {string} key
 * @param {Record<string, unknown> | undefined} reg
 */
function rowForMissingItem(key, reg) {
  if (reg && Object.keys(reg).length > 0) {
    const rid =
      typeof reg.registryId === "string" && reg.registryId.trim()
        ? reg.registryId.trim()
        : key;
    return { registryId: rid, addedAt: new Date().toISOString() };
  }
  if (key.includes("|")) {
    const pipe = key.indexOf("|");
    const title = key.slice(0, pipe).trim() || "unknown";
    const yearRaw = key.slice(pipe + 1).trim();
    const year = yearRaw === "" ? null : Number(yearRaw);
    return {
      title,
      year: Number.isFinite(year) ? year : null,
      addedAt: new Date().toISOString(),
    };
  }
  return { registryId: key, addedAt: new Date().toISOString() };
}

/**
 * @param {import("firebase-admin/firestore").Firestore} db
 * @param {string} uid
 * @param {boolean} includeShared
 */
async function collectUnion(db, uid, includeShared) {
  const uref = db.collection("users").doc(uid);
  /** @type {Map<string, Record<string, unknown>>} */
  const keyToRow = new Map();
  /** @type {Set<string>} */
  const statusOnlyKeys = new Set();

  const plSnap = await uref.collection("personalLists").get();
  for (const d of plSnap.docs) {
    const data = d.data() || {};
    const items = Array.isArray(data.items) ? data.items : [];
    for (const row of items) {
      if (!row || typeof row !== "object") continue;
      const k = listKey(row);
      if (!k) continue;
      keyToRow.set(k, pickBetterRow(keyToRow.get(k), row));
    }
    for (const arr of [data.watched, data.maybeLater, data.archive]) {
      if (!Array.isArray(arr)) continue;
      for (const x of arr) {
        const k = String(x);
        if (k) statusOnlyKeys.add(k);
      }
    }
  }

  /** @type {{ ref: import("firebase-admin/firestore").DocumentReference; id: string }[]} */
  const sharedTargets = [];
  if (includeShared) {
    const slSnap = await db.collection("sharedLists").get();
    for (const d of slSnap.docs) {
      const data = d.data() || {};
      const members = Array.isArray(data.members) ? data.members : [];
      if (!members.map(String).includes(uid)) continue;
      sharedTargets.push({ ref: d.ref, id: d.id });
      const items = Array.isArray(data.items) ? data.items : [];
      for (const row of items) {
        if (!row || typeof row !== "object") continue;
        const k = listKey(row);
        if (!k) continue;
        keyToRow.set(k, pickBetterRow(keyToRow.get(k), row));
      }
      for (const arr of [data.watched, data.maybeLater, data.archive]) {
        if (!Array.isArray(arr)) continue;
        for (const x of arr) {
          const k = String(x);
          if (k) statusOnlyKeys.add(k);
        }
      }
    }
  }

  for (const k of statusOnlyKeys) {
    if (!keyToRow.has(k)) keyToRow.set(k, null);
  }

  return { keyToRow, personalListDocs: plSnap.docs, sharedTargets };
}

async function main() {
  const write = process.argv.includes("--write");
  const includeShared = process.argv.includes("--include-shared");
  const uid = (process.env.WATCHLIST_MY_LIST_UID || "").trim();
  if (!uid) {
    console.error("Set WATCHLIST_MY_LIST_UID to your Firebase Auth uid.");
    process.exit(1);
  }

  const db = getDb();
  const myListRef = await resolveMyListPersonalRef(db, uid);
  const myListId = myListRef.id;

  const { keyToRow, personalListDocs, sharedTargets } = await collectUnion(db, uid, includeShared);

  const missingRegFetch = [...keyToRow.keys()].filter((k) => {
    const v = keyToRow.get(k);
    return v == null;
  });
  const regById = await fetchRegistryRows(db, new Set(missingRegFetch));
  for (const k of missingRegFetch) {
    keyToRow.set(k, rowForMissingItem(k, regById.get(k)));
  }

  const sortedKeys = [...keyToRow.keys()].sort();
  const finalItems = sortedKeys.map((k) => {
    const r = keyToRow.get(k);
    const base =
      r && typeof r === "object" ? r : rowForMissingItem(k, regById.get(k));
    return { ...base };
  });

  console.log(`Target My list: ${myListRef.path}`);
  console.log(`Include shared lists: ${includeShared}${includeShared ? ` (${sharedTargets.length} lists)` : ""}`);
  console.log(`Distinct titles (union): ${sortedKeys.length}`);
  console.log(`Personal list docs: ${personalListDocs.length}`);

  const backupName = `pre-consolidate-my-list-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const backupPath = join(rootDir, "backups", backupName);

  if (write) {
    mkdirSync(join(rootDir, "backups"), { recursive: true });
    const personalPayload = {};
    for (const d of personalListDocs) {
      personalPayload[d.id] = docPayload(d);
    }
    const sharedPayload = {};
    if (includeShared) {
      for (const { ref, id } of sharedTargets) {
        const s = await ref.get();
        sharedPayload[id] = docPayload(s);
      }
    }
    const backup = {
      exportedAt: new Date().toISOString(),
      script: "consolidate-all-titles-to-my-list-to-watch.mjs",
      uid,
      myListPath: myListRef.path,
      includeShared,
      userPersonalLists: personalPayload,
      sharedLists: includeShared ? sharedPayload : {},
    };
    writeFileSync(backupPath, JSON.stringify(backup, null, 2), "utf8");
    console.log(`\nBackup written: ${backupPath}`);
  } else {
    console.log(`\nDry run. Pass --write to apply (backup is created only with --write).`);
    if (sortedKeys.length <= 40) {
      for (const k of sortedKeys) console.log(`  - ${k}`);
    } else {
      sortedKeys.slice(0, 25).forEach((k) => console.log(`  - ${k}`));
      console.log(`  ... and ${sortedKeys.length - 25} more`);
    }
    return;
  }

  await myListRef.set(
    {
      items: finalItems,
      watched: [],
      maybeLater: [],
      archive: FieldValue.delete(),
    },
    { merge: true }
  );
  console.log(`✓ Updated ${myListRef.path} (${finalItems.length} items, status arrays cleared)`);

  const uref = db.collection("users").doc(uid);
  const uSnap = await uref.get();
  const prevDefault =
    uSnap.exists && typeof uSnap.data()?.defaultPersonalListId === "string"
      ? uSnap.data().defaultPersonalListId.trim()
      : "";
  if (prevDefault !== myListId) {
    await uref.set({ defaultPersonalListId: myListId }, { merge: true });
    console.log(`✓ users/${uid} defaultPersonalListId → ${myListId} (was ${prevDefault || "(unset)"})`);
  }

  for (const d of personalListDocs) {
    if (d.id === myListId) continue;
    await d.ref.set(
      {
        items: [],
        watched: [],
        maybeLater: [],
        archive: FieldValue.delete(),
      },
      { merge: true }
    );
    console.log(`✓ Cleared ${d.ref.path}`);
  }

  if (includeShared) {
    for (const { ref } of sharedTargets) {
      await ref.set(
        {
          items: [],
          watched: [],
          maybeLater: [],
          archive: FieldValue.delete(),
        },
        { merge: true }
      );
      console.log(`✓ Cleared ${ref.path}`);
    }
  }

  let batch = db.batch();
  let n = 0;
  for (const k of sortedKeys) {
    batch.set(db.collection("titleRegistry").doc(k), { listStatus: "to-watch" }, { merge: true });
    n++;
    if (n >= 400) {
      await batch.commit();
      batch = db.batch();
      n = 0;
    }
  }
  if (n > 0) await batch.commit();
  console.log(`✓ titleRegistry listStatus=to-watch for ${sortedKeys.length} keys`);
}

main().catch((err) => {
  console.error("Fatal:", err.message || err);
  process.exit(1);
});
