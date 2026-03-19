/**
 * Remove titles (by movieKey title|year) from catalog, every user list, and every shared list.
 * Strips matching keys from items, watched, maybeLater, archive and from nested string arrays.
 *
 * Run: node scripts/remove-movie-keys-from-backup.js [backup.json]
 * Edit REMOVE_KEYS below, then run.
 * Default: backups/firestore-backup-migrated.json
 *
 * Then: node scripts/restore-from-backup.js <backup>
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

/** @type {Set<string>} movieKey = title|year — edit for each run */
const REMOVE_KEYS = new Set(["Imperfect Women|2026", "Jury Duty|2023"]);

function movieKey(m) {
  return `${m?.title ?? ""}|${m.year ?? ""}`;
}

function filterItemArrays(obj) {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj.items)) {
    obj.items = obj.items.filter((m) => !REMOVE_KEYS.has(movieKey(m)));
  }
  for (const k of ["watched", "maybeLater", "archive"]) {
    if (Array.isArray(obj[k])) {
      obj[k] = obj[k].filter((key) => !REMOVE_KEYS.has(key));
    }
  }
}

function stripKeysFromAllArrays(node, depth = 0) {
  if (depth > 20 || node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (let i = node.length - 1; i >= 0; i--) {
      const el = node[i];
      if (typeof el === "string") {
        for (const rk of REMOVE_KEYS) {
          if (el === rk || el.replace(/\s/g, "") === rk.replace(/\s/g, "")) {
            node.splice(i, 1);
            break;
          }
        }
      } else if (typeof el === "object") {
        stripKeysFromAllArrays(el, depth + 1);
      }
    }
    return;
  }
  if (typeof node === "object") {
    for (const k of Object.keys(node)) {
      stripKeysFromAllArrays(node[k], depth + 1);
    }
  }
}

function main() {
  const arg = process.argv[2];
  const defaultPath = join(rootDir, "backups", "firestore-backup-migrated.json");
  const backupPath = arg && !arg.startsWith("--") ? arg : defaultPath;

  if (!existsSync(backupPath)) {
    console.error("Missing:", backupPath);
    process.exit(1);
  }

  const backup = JSON.parse(readFileSync(backupPath, "utf-8"));
  let catRemoved = 0;

  if (backup.catalog?.movies?.items) {
    const before = backup.catalog.movies.items.length;
    backup.catalog.movies.items = backup.catalog.movies.items.filter((m) => !REMOVE_KEYS.has(movieKey(m)));
    catRemoved = before - backup.catalog.movies.items.length;
  }

  let userDocs = 0;
  if (backup.users && typeof backup.users === "object") {
    for (const doc of Object.values(backup.users)) {
      if (!doc || typeof doc !== "object") continue;
      filterItemArrays(doc);
      stripKeysFromAllArrays(doc);
      userDocs++;
    }
  }

  let sharedDocs = 0;
  if (backup.sharedLists && typeof backup.sharedLists === "object") {
    for (const doc of Object.values(backup.sharedLists)) {
      if (!doc || typeof doc !== "object") continue;
      filterItemArrays(doc);
      stripKeysFromAllArrays(doc);
      sharedDocs++;
    }
  }

  backup.exportedAt = new Date().toISOString();
  writeFileSync(backupPath, JSON.stringify(backup, null, 2) + "\n", "utf-8");

  console.log(`Removed keys: ${[...REMOVE_KEYS].join(", ")}`);
  console.log(`Catalog rows removed: ${catRemoved}`);
  console.log(`User docs cleaned: ${userDocs}`);
  console.log(`Shared list docs cleaned: ${sharedDocs}`);
  console.log(`Wrote ${backupPath}`);
}

main();
