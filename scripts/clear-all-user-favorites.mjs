#!/usr/bin/env node
/**
 * Remove every favorite for one user or for all users that have a `favorites` map on
 * `users/{uid}` (same shape as `toggleFavorite` in `src/firebase.ts`).
 *
 * Before `--write`, writes a JSON snapshot of each user doc that will change.
 *
 *   node -r dotenv/config scripts/clear-all-user-favorites.mjs
 *   node -r dotenv/config scripts/clear-all-user-favorites.mjs --write --all-users
 *   node -r dotenv/config scripts/clear-all-user-favorites.mjs --write --uid <firebaseUid>
 *
 * If neither `--uid` nor `--all-users` is passed, uses **`WATCHLIST_MY_LIST_UID`** when set.
 *
 * Env: `FIREBASE_SERVICE_ACCOUNT` or `serviceAccountKey.json`.
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getDb } from "./lib/admin-init.mjs";

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

function parseArgs() {
  const argv = process.argv.slice(2);
  const write = argv.includes("--write");
  const allUsers = argv.includes("--all-users");
  const uidIdx = argv.indexOf("--uid");
  const uid = uidIdx >= 0 && argv[uidIdx + 1] ? String(argv[uidIdx + 1]).trim() : "";
  return { write, allUsers, uid };
}

/** @param {Record<string, unknown> | undefined} data */
function favoritesKeyCount(data) {
  const fav = data?.favorites;
  if (!fav || typeof fav !== "object" || Array.isArray(fav)) return 0;
  return Object.keys(fav).length;
}

async function main() {
  const { write, allUsers, uid: uidArg } = parseArgs();
  const envUid = (process.env.WATCHLIST_MY_LIST_UID || "").trim();
  const db = getDb();

  /** @type {string[]} */
  let targetUids = [];
  if (allUsers) {
    const snap = await db.collection("users").get();
    for (const d of snap.docs) {
      const data = d.data() || {};
      if (favoritesKeyCount(data) > 0) targetUids.push(d.id);
    }
    targetUids.sort();
  } else {
    const uid = uidArg || envUid;
    if (!uid) {
      console.error("Pass --uid <uid>, or --all-users, or set WATCHLIST_MY_LIST_UID.");
      process.exit(1);
    }
    const snap = await db.collection("users").doc(uid).get();
    if (!snap.exists) {
      console.error(`users/${uid} does not exist.`);
      process.exit(1);
    }
    targetUids = [uid];
  }

  console.log(write ? "MODE: WRITE" : "MODE: dry-run (pass --write to apply)");
  if (allUsers) {
    console.log(`Users with favorites: ${targetUids.length}`);
    for (const u of targetUids) {
      const s = await db.collection("users").doc(u).get();
      const n = favoritesKeyCount(s.data());
      console.log(`  ${u}  (${n} keys)`);
    }
  } else {
    const s = await db.collection("users").doc(targetUids[0]).get();
    const n = favoritesKeyCount(s.data());
    console.log(`users/${targetUids[0]}  favorites keys: ${n}`);
  }

  if (!write) {
    console.log("\nDry run only.");
    return;
  }

  if (targetUids.length === 0) {
    console.log("Nothing to clear.");
    return;
  }

  mkdirSync(join(rootDir, "backups"), { recursive: true });
  const backupName = `pre-clear-favorites-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const backupPath = join(rootDir, "backups", backupName);
  /** @type {Record<string, unknown>} */
  const backup = {
    exportedAt: new Date().toISOString(),
    script: "clear-all-user-favorites.mjs",
    userSnapshots: {},
  };

  for (const uid of targetUids) {
    const snap = await db.collection("users").doc(uid).get();
    backup.userSnapshots[uid] = {
      path: snap.ref.path,
      data: snap.exists ? jsonSafe(snap.data()) : null,
    };
  }
  writeFileSync(backupPath, JSON.stringify(backup, null, 2), "utf8");
  console.log(`\nBackup written: ${backupPath}`);

  for (const uid of targetUids) {
    await db.collection("users").doc(uid).update({ favorites: FieldValue.delete() });
    console.log(`✓ Cleared favorites on users/${uid}`);
  }
}

main().catch((e) => {
  console.error("Fatal:", e.message || e);
  process.exit(1);
});
