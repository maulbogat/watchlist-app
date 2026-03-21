/**
 * List every titleRegistry / user / shared-list row with no playable youtubeId (null, missing, invalid).
 *
 * Run: node scripts/list-items-without-youtube-trailer.js [backup.json]
 * Default: backups/firestore-backup.json
 * Output: stdout + backups/items-without-youtube-trailer.txt
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { isPlayableYoutubeTrailerId } from "../lib/youtube-trailer-id.js";
import { trMapFromBackup, hydrateBackupRow } from "./lib/backup-list.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const defaultPath = join(rootDir, "backups", "firestore-backup.json");

function walkAllItems(backup, trMap, fn) {
  for (const [rid, row] of Object.entries(backup.titleRegistry || {})) {
    if (!row || typeof row !== "object") continue;
    const m = { registryId: rid, ...row };
    fn(`titleRegistry:${rid}`, m);
  }
  for (const [uid, doc] of Object.entries(backup.users || {})) {
    if (!Array.isArray(doc?.items)) continue;
    for (let i = 0; i < doc.items.length; i++) {
      const h = hydrateBackupRow(doc.items[i], trMap);
      if (h) fn(`user:${uid}`, h, doc.items, i);
    }
  }
  for (const [lid, doc] of Object.entries(backup.sharedLists || {})) {
    if (!Array.isArray(doc?.items)) continue;
    for (let i = 0; i < doc.items.length; i++) {
      const h = hydrateBackupRow(doc.items[i], trMap);
      if (h) fn(`shared:${lid}`, h, doc.items, i);
    }
  }
}

function main() {
  const arg = process.argv[2];
  const backupPath = arg && !arg.startsWith("--") ? arg : defaultPath;
  if (!existsSync(backupPath)) {
    console.error("Missing file:", backupPath);
    process.exit(1);
  }
  const backup = JSON.parse(readFileSync(backupPath, "utf-8"));
  const trMap = trMapFromBackup(backup);
  const lines = [];
  const rows = [];

  walkAllItems(backup, trMap, (where, m) => {
    if (!m) return;
    if (isPlayableYoutubeTrailerId(m.youtubeId)) return;
    const title = m.title ?? "—";
    const year = m.year ?? "—";
    const imdb = m.imdbId ?? "—";
    const tmdb = m.tmdbId ?? "—";
    const reg = m.registryId ?? "—";
    const raw =
      m.youtubeId === undefined
        ? "(missing)"
        : m.youtubeId === null
          ? "null"
          : JSON.stringify(m.youtubeId);
    const line = `[${where}] "${title}" (${year})  registry=${reg}  imdb=${imdb}  tmdbId=${tmdb}  youtubeId=${raw}`;
    lines.push(line);
    rows.push({ where, title, year, imdbId: imdb, tmdbId: tmdb, youtubeId: m.youtubeId, registryId: reg });
  });

  const header = `Items with no playable YouTube trailer id (${rows.length} row(s))\nBackup: ${backupPath}\nGenerated: ${new Date().toISOString()}\n`;
  const body = lines.join("\n") + (lines.length ? "\n" : "");
  const out = header + "\n" + body;

  console.log(out);
  const reportPath = join(rootDir, "backups", "items-without-youtube-trailer.txt");
  writeFileSync(reportPath, out, "utf-8");
  console.log(`\nWrote ${reportPath}`);
}

main();
