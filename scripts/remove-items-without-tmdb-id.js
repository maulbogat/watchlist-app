/**
 * Remove every list/catalog row that has no numeric tmdbId (null, "", or invalid).
 * Strips matching movieKey() from watched / maybeLater / archive (and removed on shared lists).
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

function movieKey(m) {
  return `${m.title}|${m.year ?? ""}`;
}

function hasTmdbId(m) {
  const t = m?.tmdbId;
  if (t == null || t === "") return false;
  const n = Number(t);
  return !Number.isNaN(n);
}

const USER_STATUS = ["watched", "maybeLater", "archive"];
const SHARED_STATUS = ["removed", "watched", "maybeLater", "archive"];

function stripKeys(doc, fields, keySet) {
  for (const f of fields) {
    if (!Array.isArray(doc[f])) continue;
    doc[f] = doc[f].filter((k) => !keySet.has(k));
  }
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
  let catalogRemoved = 0;
  let userRemoved = 0;
  let sharedRemoved = 0;

  const cat = backup.catalog?.movies?.items;
  if (Array.isArray(cat)) {
    const drop = [];
    const next = [];
    for (const m of cat) {
      if (!hasTmdbId(m)) {
        drop.push(movieKey(m));
        catalogRemoved++;
        removedLines.push(`catalog  ${movieKey(m)}  "${m.title ?? ""}"`);
      } else next.push(m);
    }
    if (!dryRun) backup.catalog.movies.items = next;
  }

  for (const [uid, doc] of Object.entries(backup.users || {})) {
    if (!Array.isArray(doc?.items)) continue;
    const keys = new Set();
    const next = [];
    for (const m of doc.items) {
      if (!hasTmdbId(m)) {
        keys.add(movieKey(m));
        userRemoved++;
        removedLines.push(`user:${uid}  ${movieKey(m)}  "${m.title ?? ""}"`);
      } else next.push(m);
    }
    if (!dryRun) {
      doc.items = next;
      stripKeys(doc, USER_STATUS, keys);
    }
  }

  for (const [lid, doc] of Object.entries(backup.sharedLists || {})) {
    if (!Array.isArray(doc?.items)) continue;
    const keys = new Set();
    const next = [];
    for (const m of doc.items) {
      if (!hasTmdbId(m)) {
        keys.add(movieKey(m));
        sharedRemoved++;
        removedLines.push(`shared:${lid}  ${movieKey(m)}  "${m.title ?? ""}"`);
      } else next.push(m);
    }
    if (!dryRun) {
      doc.items = next;
      stripKeys(doc, SHARED_STATUS, keys);
    }
  }

  const total = catalogRemoved + userRemoved + sharedRemoved;
  const reportPath = join(rootDir, "backups", "remove-no-tmdb-report.txt");
  const lines = [
    `remove-items-without-tmdb-id`,
    dryRun ? "DRY RUN — no file write" : `Written: ${new Date().toISOString()}`,
    `Source: ${backupPath}`,
    ``,
    `Removed from catalog: ${catalogRemoved}`,
    `Removed from users: ${userRemoved}`,
    `Removed from sharedLists: ${sharedRemoved}`,
    `Total rows removed: ${total}`,
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
