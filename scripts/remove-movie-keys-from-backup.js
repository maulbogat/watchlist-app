/**
 * Remove titles from titleRegistry and every user / shared / personal list.
 * Matching keys in REMOVE_KEYS: `title|year` (listKey) and/or registry doc ids (e.g. tt…, legacy-…).
 * Strips matching keys from items, watched, maybeLater, legacy archive, and nested string arrays.
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
import { listKey } from "../lib/registry-id.js";
import { mutateTitleRegistryInBackup } from "./lib/backup-title-registry.mjs";
import { trMapFromBackup, backupListKey } from "./lib/backup-list.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

/** @type {Set<string>} listKey title|year and/or registryId — edit for each run */
const REMOVE_KEYS = new Set(["Imperfect Women|2026", "Jury Duty|2023"]);

function rowMatchesRemove(m, trMap) {
  if (!m || typeof m !== "object") return false;
  if (m.registryId && REMOVE_KEYS.has(m.registryId)) return true;
  return REMOVE_KEYS.has(backupListKey(m, trMap));
}

function filterItemArrays(doc, trMap) {
  if (!doc || typeof doc !== "object") return;
  if (Array.isArray(doc.items)) {
    doc.items = doc.items.filter((m) => !rowMatchesRemove(m, trMap));
  }
  for (const k of ["watched", "maybeLater", "archive"]) {
    if (Array.isArray(doc[k])) {
      doc[k] = doc[k].filter((key) => !REMOVE_KEYS.has(key));
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

  let regBefore = Object.keys(backup.titleRegistry || {}).length;
  mutateTitleRegistryInBackup(backup, (items) =>
    items.filter((m) => {
      const k = listKey(m);
      if (REMOVE_KEYS.has(m.registryId)) return false;
      return !REMOVE_KEYS.has(k);
    })
  );
  let regAfter = Object.keys(backup.titleRegistry || {}).length;

  const trMap2 = trMapFromBackup(backup);

  let userDocs = 0;
  if (backup.users && typeof backup.users === "object") {
    for (const doc of Object.values(backup.users)) {
      if (!doc || typeof doc !== "object") continue;
      filterItemArrays(doc, trMap2);
      stripKeysFromAllArrays(doc);
      userDocs++;
    }
  }

  let sharedDocs = 0;
  if (backup.sharedLists && typeof backup.sharedLists === "object") {
    for (const doc of Object.values(backup.sharedLists)) {
      if (!doc || typeof doc !== "object") continue;
      filterItemArrays(doc, trMap2);
      stripKeysFromAllArrays(doc);
      sharedDocs++;
    }
  }

  if (backup.userPersonalLists && typeof backup.userPersonalLists === "object") {
    for (const lists of Object.values(backup.userPersonalLists)) {
      if (!lists || typeof lists !== "object") continue;
      for (const doc of Object.values(lists)) {
        if (!doc || typeof doc !== "object") continue;
        filterItemArrays(doc, trMap2);
        stripKeysFromAllArrays(doc);
      }
    }
  }

  backup.exportedAt = new Date().toISOString();
  writeFileSync(backupPath, JSON.stringify(backup, null, 2) + "\n", "utf-8");

  console.log(`Removed keys: ${[...REMOVE_KEYS].join(", ")}`);
  console.log(`titleRegistry docs: ${regBefore} → ${regAfter} (removed ${regBefore - regAfter})`);
  console.log(`User docs cleaned: ${userDocs}`);
  console.log(`Shared list docs cleaned: ${sharedDocs}`);
  console.log(`Wrote ${backupPath}`);
}

main();
