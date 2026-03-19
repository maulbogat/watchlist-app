/**
 * List every catalog / user / shared-list row with no playable youtubeId (null, missing, invalid).
 *
 * Run: node scripts/list-items-without-youtube-trailer.js [backup.json]
 * Default: backups/firestore-backup.json
 * Output: stdout + backups/items-without-youtube-trailer.txt
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { isPlayableYoutubeTrailerId } from "../lib/youtube-trailer-id.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const defaultPath = join(rootDir, "backups", "firestore-backup.json");

function walkAllItems(backup, fn) {
  const cat = backup.catalog?.movies?.items;
  if (Array.isArray(cat)) {
    for (let i = 0; i < cat.length; i++) fn("catalog", cat, i);
  }
  for (const [uid, doc] of Object.entries(backup.users || {})) {
    if (!Array.isArray(doc?.items)) continue;
    for (let i = 0; i < doc.items.length; i++) fn(`user:${uid}`, doc.items, i);
  }
  for (const [lid, doc] of Object.entries(backup.sharedLists || {})) {
    if (!Array.isArray(doc?.items)) continue;
    for (let i = 0; i < doc.items.length; i++) fn(`shared:${lid}`, doc.items, i);
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
  const lines = [];
  const rows = [];

  walkAllItems(backup, (where, arr, i) => {
    const m = arr[i];
    if (!m) return;
    if (isPlayableYoutubeTrailerId(m.youtubeId)) return;
    const title = m.title ?? "—";
    const year = m.year ?? "—";
    const imdb = m.imdbId ?? "—";
    const tmdb = m.tmdbId ?? "—";
    const raw =
      m.youtubeId === undefined
        ? "(missing)"
        : m.youtubeId === null
          ? "null"
          : JSON.stringify(m.youtubeId);
    const line = `[${where}] "${title}" (${year})  imdb=${imdb}  tmdbId=${tmdb}  youtubeId=${raw}`;
    lines.push(line);
    rows.push({ where, title, year, imdbId: imdb, tmdbId: tmdb, youtubeId: m.youtubeId });
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
