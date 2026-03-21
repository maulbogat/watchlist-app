/**
 * List keys that appear in titleRegistry, sharedLists, or users but not in all three.
 * Keys: registryId for `{ registryId }` rows; else title|year for embedded rows.
 *
 * Run: node scripts/report-items-not-in-all-three.js [backup.json]
 * Default: backups/firestore-backup-migrated.json
 * Report: backups/items-not-in-all-three-report.txt
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { listKey } from "../lib/registry-id.js";
import { trMapFromBackup, hydrateBackupRow } from "./lib/backup-list.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

function collectRegistryKeys(backup) {
  const s = new Set();
  for (const [rid, row] of Object.entries(backup.titleRegistry || {})) {
    if (!row || typeof row !== "object") continue;
    s.add(rid);
    s.add(listKey({ registryId: rid, ...row }));
  }
  return s;
}

function collectKeysFromListItems(items, trMap) {
  const s = new Set();
  if (!Array.isArray(items)) return s;
  for (const m of items) {
    const h = hydrateBackupRow(m, trMap);
    if (!h) continue;
    if (m?.registryId) s.add(m.registryId);
    s.add(listKey(h));
  }
  return s;
}

function main() {
  const arg = process.argv[2];
  const defaultPath = join(rootDir, "backups", "firestore-backup-migrated.json");
  const altPath = join(rootDir, "backups", "firestore-backup.json");
  const backupPath =
    arg && !arg.startsWith("--") ? arg : existsSync(defaultPath) ? defaultPath : altPath;

  if (!existsSync(backupPath)) {
    console.error("Missing:", backupPath);
    process.exit(1);
  }

  const backup = JSON.parse(readFileSync(backupPath, "utf-8"));
  const trMap = trMapFromBackup(backup);

  const registryKeys = collectRegistryKeys(backup);

  const sharedKeys = new Set();
  const sharedByKey = new Map();
  for (const [listId, doc] of Object.entries(backup.sharedLists || {})) {
    for (const k of collectKeysFromListItems(doc?.items, trMap)) {
      sharedKeys.add(k);
      if (!sharedByKey.has(k)) sharedByKey.set(k, []);
      sharedByKey.get(k).push(listId);
    }
  }

  const userKeys = new Set();
  const usersByKey = new Map();
  for (const [uid, doc] of Object.entries(backup.users || {})) {
    for (const k of collectKeysFromListItems(doc?.items, trMap)) {
      userKeys.add(k);
      if (!usersByKey.has(k)) usersByKey.set(k, []);
      usersByKey.get(k).push(uid);
    }
  }

  const union = new Set([...registryKeys, ...sharedKeys, ...userKeys]);

  const incomplete = [];
  for (const key of union) {
    const inRegistry = registryKeys.has(key);
    const inShared = sharedKeys.has(key);
    const inUsers = userKeys.has(key);
    const count = (inRegistry ? 1 : 0) + (inShared ? 1 : 0) + (inUsers ? 1 : 0);
    if (count < 3) {
      incomplete.push({ key, inRegistry, inShared, inUsers, count });
    }
  }

  incomplete.sort((a, b) => {
    if (a.count !== b.count) return a.count - b.count;
    return String(a.key).localeCompare(String(b.key));
  });

  const label = (row) => {
    const p = [];
    if (row.inRegistry) p.push("registry");
    if (row.inShared) p.push("shared");
    if (row.inUsers) p.push("users");
    return p.join("+") || "(none)";
  };

  const lines = [
    `Items not in all three places (titleRegistry + sharedLists + users)`,
    `Backup: ${backupPath}`,
    `Generated: ${new Date().toISOString()}`,
    `Keys: registryId and/or title|year`,
    ``,
    `Total unique keys (anywhere): ${union.size}`,
    `Keys in all 3 places: ${union.size - incomplete.length}`,
    `Keys missing from at least one place: ${incomplete.length}`,
    ``,
  ];

  const byPattern = new Map();
  for (const row of incomplete) {
    const L = label(row);
    if (!byPattern.has(L)) byPattern.set(L, []);
    byPattern.get(L).push(row.key);
  }

  lines.push("Summary by location pattern:");
  for (const [pat, keys] of [...byPattern.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`  ${pat}: ${keys.length}`);
  }
  lines.push("");

  for (const row of incomplete) {
    let extra = "";
    if (row.inShared && sharedByKey.has(row.key)) {
      extra += ` sharedLists=[${sharedByKey.get(row.key).join(", ")}]`;
    }
    if (row.inUsers && usersByKey.has(row.key)) {
      extra += ` users=[${usersByKey.get(row.key).map((u) => u.slice(0, 8) + "…").join(", ")}]`;
    }
    lines.push(`[${row.count}/3] ${label(row)}  ${JSON.stringify(row.key)}${extra}`);
  }

  const body = lines.join("\n") + "\n";
  const reportPath = join(rootDir, "backups", "items-not-in-all-three-report.txt");
  writeFileSync(reportPath, body, "utf-8");

  console.log(body);
  console.log(`Wrote ${reportPath}`);
}

main();
