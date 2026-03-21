/**
 * Remove titleRegistry docs and list rows that have no numeric tmdbId (null, "", or invalid).
 * Strips matching registryId / title|year from watched / maybeLater / archive.
 *
 * Run: node scripts/remove-items-without-tmdb-id.js [backup.json] [--dry-run]
 * Default: backups/firestore-backup-migrated.json
 * Report: backups/remove-no-tmdb-report.txt
 *
 * After review: node scripts/restore-from-backup.js <file>
 */
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { listKey } from "../lib/registry-id.js";
import { mutateTitleRegistryInBackup } from "./lib/backup-title-registry.mjs";
import { trMapFromBackup, hydrateBackupRow } from "./lib/backup-list.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

function hasTmdbId(m) {
  const t = m?.tmdbId;
  if (t == null || t === "") return false;
  const n = Number(t);
  return !Number.isNaN(n);
}

const STATUS_FIELDS = ["watched", "maybeLater", "archive"];

function keysForRow(m, trMap) {
  const ks = new Set();
  if (m?.registryId) ks.add(m.registryId);
  const h = hydrateBackupRow(m, trMap);
  if (h) ks.add(listKey(h));
  return ks;
}

function stripKeys(doc, fields, keySet) {
  for (const f of fields) {
    if (!Array.isArray(doc[f])) continue;
    doc[f] = doc[f].filter((k) => !keySet.has(k));
  }
}

function filterListDoc(doc, trMap, removedLines, prefix, dryRun) {
  if (!Array.isArray(doc?.items)) return 0;
  const strip = new Set();
  let n = 0;
  const next = [];
  for (const m of doc.items) {
    const h = hydrateBackupRow(m, trMap);
    if (!hasTmdbId(h)) {
      for (const k of keysForRow(m, trMap)) strip.add(k);
      n++;
      removedLines.push(`${prefix}  ${[...keysForRow(m, trMap)].join("|")}  "${h?.title ?? ""}"`);
    } else next.push(m);
  }
  if (!dryRun) {
    doc.items = next;
    stripKeys(doc, STATUS_FIELDS, strip);
  }
  return n;
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--dry-run");
  const dryRun = process.argv.includes("--dry-run");

  const defaultPath = join(rootDir, "backups", "firestore-backup-migrated.json");
  const altPath = join(rootDir, "backups", "firestore-backup.json");
  let backupPath = args[0] || (existsSync(defaultPath) ? defaultPath : altPath);

  let backup;
  try {
    backup = JSON.parse(readFileSync(backupPath, "utf-8"));
  } catch (e) {
    console.error("Cannot read", backupPath, e.message);
    process.exit(1);
  }

  const removedLines = [];
  let registryRemoved = 0;

  const trMap0 = trMapFromBackup(backup);
  const beforeReg = Object.keys(backup.titleRegistry || {}).length;
  if (!dryRun) {
    mutateTitleRegistryInBackup(backup, (items) => {
      const kept = items.filter((m) => {
        if (hasTmdbId(m)) return true;
        registryRemoved++;
        removedLines.push(`titleRegistry  ${m.registryId}  "${m.title ?? ""}"`);
        return false;
      });
      return kept;
    });
  } else {
    for (const m of Object.values(trMap0)) {
      if (!hasTmdbId(m)) {
        registryRemoved++;
        removedLines.push(`titleRegistry  ${m.registryId}  "${m.title ?? ""}"`);
      }
    }
  }
  const afterReg = dryRun ? beforeReg : Object.keys(backup.titleRegistry || {}).length;

  const trMap = dryRun ? trMap0 : trMapFromBackup(backup);

  let userRemoved = 0;
  for (const [uid, doc] of Object.entries(backup.users || {})) {
    userRemoved += filterListDoc(doc, trMap, removedLines, `user:${uid}`, dryRun);
  }

  let sharedRemoved = 0;
  for (const [lid, doc] of Object.entries(backup.sharedLists || {})) {
    sharedRemoved += filterListDoc(doc, trMap, removedLines, `shared:${lid}`, dryRun);
  }

  if (backup.userPersonalLists && typeof backup.userPersonalLists === "object") {
    for (const [uid, lists] of Object.entries(backup.userPersonalLists)) {
      if (!lists || typeof lists !== "object") continue;
      for (const [plid, doc] of Object.entries(lists)) {
        filterListDoc(doc, trMap, removedLines, `personal:${uid}/${plid}`, dryRun);
      }
    }
  }

  const total = registryRemoved + userRemoved + sharedRemoved;
  const reportPath = join(rootDir, "backups", "remove-no-tmdb-report.txt");
  const lines = [
    `remove-items-without-tmdb-id (titleRegistry model)`,
    dryRun ? "DRY RUN — no file write" : `Written: ${new Date().toISOString()}`,
    `Source: ${backupPath}`,
    ``,
    `titleRegistry docs removed: ${registryRemoved} (${beforeReg} → ${afterReg})`,
    `Rows removed from users: ${userRemoved}`,
    `Rows removed from sharedLists: ${sharedRemoved}`,
    `Total rows/lines removed: ${total}`,
    ``,
    ...removedLines,
  ];

  if (!dryRun) {
    backup.exportedAt = new Date().toISOString();
    writeFileSync(backupPath, JSON.stringify(backup, null, 2), "utf-8");
  }
  writeFileSync(reportPath, lines.join("\n"), "utf-8");

  console.log(lines.slice(0, 12).join("\n"));
  console.log(`\nReport: ${reportPath}`);
  if (dryRun) console.log("\nRun without --dry-run to apply changes to the backup file.");
  else console.log(`\nUpdated: ${backupPath}`);
  console.log("\nRestore to Firestore: node scripts/restore-from-backup.js " + backupPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
