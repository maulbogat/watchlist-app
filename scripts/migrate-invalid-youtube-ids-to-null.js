/**
 * Set youtubeId to null on any item whose value is not a valid YouTube video id
 * (e.g. legacy placeholders, typos, empty string).
 *
 * Run: node scripts/migrate-invalid-youtube-ids-to-null.js [backup.json]
 * Default: backups/firestore-backup.json
 * Then: node scripts/restore-from-backup.js <same file>
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { isPlayableYoutubeTrailerId } from "../lib/youtube-trailer-id.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const defaultPath = join(rootDir, "backups", "firestore-backup.json");

function fixYoutube(arr, i) {
  const y = arr[i]?.youtubeId;
  if (y == null || y === "") return 0;
  if (isPlayableYoutubeTrailerId(y)) return 0;
  arr[i] = { ...arr[i], youtubeId: null };
  return 1;
}

function fixYoutubeRow(row) {
  const y = row?.youtubeId;
  if (y == null || y === "") return 0;
  if (isPlayableYoutubeTrailerId(y)) return 0;
  row.youtubeId = null;
  return 1;
}

function main() {
  const arg = process.argv[2];
  const backupPath = arg && !arg.startsWith("--") ? arg : defaultPath;
  if (!existsSync(backupPath)) {
    console.error("Missing file:", backupPath);
    process.exit(1);
  }
  const backup = JSON.parse(readFileSync(backupPath, "utf-8"));
  let changed = 0;
  for (const row of Object.values(backup.titleRegistry || {})) {
    if (row && typeof row === "object") changed += fixYoutubeRow(row);
  }
  for (const doc of Object.values(backup.users || {})) {
    if (!Array.isArray(doc?.items)) continue;
    for (let i = 0; i < doc.items.length; i++) changed += fixYoutube(doc.items, i);
  }
  for (const doc of Object.values(backup.sharedLists || {})) {
    if (!Array.isArray(doc?.items)) continue;
    for (let i = 0; i < doc.items.length; i++) changed += fixYoutube(doc.items, i);
  }
  if (backup.userPersonalLists && typeof backup.userPersonalLists === "object") {
    for (const lists of Object.values(backup.userPersonalLists)) {
      if (!lists || typeof lists !== "object") continue;
      for (const doc of Object.values(lists)) {
        if (!Array.isArray(doc?.items)) continue;
        for (let i = 0; i < doc.items.length; i++) changed += fixYoutube(doc.items, i);
      }
    }
  }
  backup.exportedAt = new Date().toISOString();
  writeFileSync(backupPath, JSON.stringify(backup, null, 2), "utf-8");
  console.log(`Updated ${changed} item row(s): invalid youtubeId → null`);
  console.log(`Wrote ${backupPath}`);
  console.log("Run: node scripts/restore-from-backup.js " + backupPath);
}

main();
