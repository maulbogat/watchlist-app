/**
 * List every movieKey that appears in catalog, sharedLists, or users but not in all three.
 * Matching: movieKey(m) = `${title}|${year ?? ""}` (same as firebase.js).
 *
 * Run: node scripts/report-items-not-in-all-three.js [backup.json]
 * Default: backups/firestore-backup-migrated.json
 * Report: backups/items-not-in-all-three-report.txt
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

function movieKey(m) {
  return `${m?.title ?? ""}|${m.year ?? ""}`;
}

function collectKeysFromItems(items) {
  const s = new Set();
  if (!Array.isArray(items)) return s;
  for (const m of items) {
    if (m && (m.title != null || m.year != null)) s.add(movieKey(m));
  }
  return s;
}

function main() {
  const arg = process.argv[2];
  const defaultPath = join(rootDir, "backups", "firestore-backup-migrated.json");
  const altPath = join(rootDir, "backups", "firestore-backup.json");
  const backupPath =
    arg && !arg.startsWith("--")
      ? arg
      : existsSync(defaultPath)
        ? defaultPath
        : altPath;

  if (!existsSync(backupPath)) {
    console.error("Missing:", backupPath);
    process.exit(1);
  }

  const backup = JSON.parse(readFileSync(backupPath, "utf-8"));

  const catalogKeys = collectKeysFromItems(backup.catalog?.movies?.items);

  const sharedKeys = new Set();
  const sharedByKey = new Map(); // key -> list of list ids
  for (const [listId, doc] of Object.entries(backup.sharedLists || {})) {
    for (const m of doc?.items || []) {
      if (m && (m.title != null || m.year != null)) {
        const key = movieKey(m);
        sharedKeys.add(key);
        if (!sharedByKey.has(key)) sharedByKey.set(key, []);
        sharedByKey.get(key).push(listId);
      }
    }
  }

  const userKeys = new Set();
  const usersByKey = new Map();
  for (const [uid, doc] of Object.entries(backup.users || {})) {
    for (const m of doc?.items || []) {
      if (m && (m.title != null || m.year != null)) {
        const key = movieKey(m);
        userKeys.add(key);
        if (!usersByKey.has(key)) usersByKey.set(key, []);
        usersByKey.get(key).push(uid);
      }
    }
  }

  const union = new Set([...catalogKeys, ...sharedKeys, ...userKeys]);

  /** @type {{ key: string, inCatalog: boolean, inShared: boolean, inUsers: boolean, count: number }[]} */
  const incomplete = [];
  for (const key of union) {
    const inCatalog = catalogKeys.has(key);
    const inShared = sharedKeys.has(key);
    const inUsers = userKeys.has(key);
    const count = (inCatalog ? 1 : 0) + (inShared ? 1 : 0) + (inUsers ? 1 : 0);
    if (count < 3) {
      incomplete.push({ key, inCatalog, inShared, inUsers, count });
    }
  }

  incomplete.sort((a, b) => {
    if (a.count !== b.count) return a.count - b.count;
    return a.key.localeCompare(b.key);
  });

  const label = (row) => {
    const p = [];
    if (row.inCatalog) p.push("catalog");
    if (row.inShared) p.push("shared");
    if (row.inUsers) p.push("users");
    return p.join("+") || "(none)";
  };

  const lines = [
    `Items not in all three places (catalog + sharedLists + users)`,
    `Backup: ${backupPath}`,
    `Generated: ${new Date().toISOString()}`,
    `Matching: title|year`,
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
