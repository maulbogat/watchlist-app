/**
 * Add tmdbId to every item that has imdbId, using TMDB /find?external_source=imdb_id.
 * Writes the numeric TMDB id (movie or tv) on catalog, users, and sharedLists items.
 *
 * Run: node scripts/add-tmdb-ids-from-imdb.js [backup.json] [--dry-run]
 * Default: backups/firestore-backup-migrated.json
 *
 * Requires: TMDB_API_KEY in .env
 * Report: backups/add-tmdb-ids-report.txt
 */
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import https from "https";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const DELAY_MS = 260;

function normImdb(id) {
  const s = String(id || "").trim();
  if (!s) return "";
  return s.startsWith("tt") ? s : `tt${s}`;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

/** When both movie + TV exist for one IMDb id, prefer row type; else prefer TV (see add-from-imdb). */
async function findTmdbByImdb(imdbId, apiKey, itemTypeHint) {
  const url = `https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}?external_source=imdb_id&api_key=${apiKey}`;
  const find = await fetchJson(url);
  const movie = find.movie_results?.[0];
  const tv = find.tv_results?.[0];
  if (!movie && !tv) return null;
  if (!movie) return { tmdbId: tv.id, media: "tv" };
  if (!tv) return { tmdbId: movie.id, media: "movie" };
  if (itemTypeHint === "movie") return { tmdbId: movie.id, media: "movie" };
  if (itemTypeHint === "show") return { tmdbId: tv.id, media: "tv" };
  return { tmdbId: tv.id, media: "tv" };
}

function walkAllItems(backup, fn) {
  const cat = backup.catalog?.movies?.items;
  if (Array.isArray(cat)) {
    for (let i = 0; i < cat.length; i++) fn(cat, i, "catalog");
  }
  for (const [uid, doc] of Object.entries(backup.users || {})) {
    if (!Array.isArray(doc?.items)) continue;
    for (let i = 0; i < doc.items.length; i++) fn(doc.items, i, `user:${uid}`);
  }
  for (const [lid, doc] of Object.entries(backup.sharedLists || {})) {
    if (!Array.isArray(doc?.items)) continue;
    for (let i = 0; i < doc.items.length; i++) fn(doc.items, i, `shared:${lid}`);
  }
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--dry-run");
  const dryRun = process.argv.includes("--dry-run");

  const defaultPath = join(rootDir, "backups", "firestore-backup-migrated.json");
  const altPath = join(rootDir, "backups", "firestore-backup.json");
  let backupPath = args[0] || (existsSync(defaultPath) ? defaultPath : altPath);

  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) {
    console.error("Set TMDB_API_KEY in .env");
    process.exit(1);
  }

  let backup;
  try {
    backup = JSON.parse(readFileSync(backupPath, "utf-8"));
  } catch (e) {
    console.error("Cannot read", backupPath, e.message);
    process.exit(1);
  }

  const unique = new Set();
  const idToTypeHint = new Map();
  walkAllItems(backup, (arr, i) => {
    const m = arr[i];
    const id = normImdb(m?.imdbId);
    if (/^tt\d+$/.test(id)) {
      unique.add(id);
      if (!idToTypeHint.has(id)) {
        const t = m?.type;
        if (t === "show" || t === "movie") idToTypeHint.set(id, t);
      }
    }
  });

  const cache = new Map();
  walkAllItems(backup, (arr, i) => {
    const m = arr[i];
    const id = normImdb(m?.imdbId);
    if (!/^tt\d+$/.test(id)) return;
    if (m.tmdbId != null && m.tmdbId !== "") {
      const n = Number(m.tmdbId);
      if (!Number.isNaN(n)) {
        const cur = cache.get(id);
        if (!cur) cache.set(id, { tmdbId: n, from: "existing" });
      }
    }
  });

  const toFetch = [...unique].filter((id) => !cache.has(id));
  console.log(`Backup: ${backupPath}`);
  console.log(`Unique imdbIds: ${unique.size}, already have tmdbId in data: ${unique.size - toFetch.length}, to resolve via API: ${toFetch.length}`);
  if (dryRun) {
    console.log(
      "\n[--dry-run] Skipping TMDB API calls and file writes. Run without --dry-run to apply (~" +
        Math.ceil((toFetch.length * DELAY_MS) / 1000) +
        "s minimum for API pacing)."
    );
    process.exit(0);
  }

  const errors = [];
  for (const imdbId of toFetch) {
    try {
      const res = await findTmdbByImdb(imdbId, apiKey, idToTypeHint.get(imdbId));
      if (res) cache.set(imdbId, { ...res, from: "api" });
      else errors.push({ imdbId, err: "no movie/tv in TMDB find" });
    } catch (e) {
      errors.push({ imdbId, err: String(e.message || e) });
    }
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  let updated = 0;
  let skippedHadId = 0;
  walkAllItems(backup, (arr, i) => {
    const m = arr[i];
    const id = normImdb(m?.imdbId);
    if (!/^tt\d+$/.test(id)) return;
    if (m.tmdbId != null && m.tmdbId !== "" && !Number.isNaN(Number(m.tmdbId))) {
      skippedHadId++;
      return;
    }
    const hit = cache.get(id);
    if (!hit || hit.tmdbId == null) return;
    const next = { ...m, tmdbId: hit.tmdbId };
    if (hit.media) next.tmdbMedia = hit.media;
    arr[i] = next;
    updated++;
  });

  const reportPath = join(rootDir, "backups", "add-tmdb-ids-report.txt");
  const lines = [
    `add-tmdb-ids-from-imdb`,
    `Generated: ${new Date().toISOString()}`,
    `Backup: ${backupPath}`,
    ``,
    `Unique imdbIds: ${unique.size}`,
    `Resolved from existing rows: ${unique.size - toFetch.length}`,
    `TMDB API lookups: ${toFetch.length}`,
    `Rows updated with tmdbId: ${updated}`,
    `Rows skipped (already had tmdbId): ${skippedHadId}`,
    `Find failures: ${errors.length}`,
    ``,
  ];
  if (errors.length) {
    lines.push("Failures (first 50):");
    errors.slice(0, 50).forEach((x) => lines.push(`  ${x.imdbId}: ${x.err}`));
  }

  console.log(lines.filter(Boolean).join("\n"));

  backup.exportedAt = new Date().toISOString();
  writeFileSync(backupPath, JSON.stringify(backup, null, 2), "utf-8");
  writeFileSync(reportPath, lines.filter(Boolean).join("\n"), "utf-8");
  console.log(`\nWrote ${backupPath}`);
  console.log(`Report: ${reportPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
