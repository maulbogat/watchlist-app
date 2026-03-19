/**
 * 1) Removes any existing youtubeId on every catalog/user/shared list item.
 * 2) For each item with tmdbId, fetches TMDB /movie|tv/{id}?append_to_response=videos
 *    and sets youtubeId to the YouTube trailer key, or null if TMDB has none.
 * 3) Items without tmdbId get youtubeId: null.
 *
 * Run: node scripts/backfill-youtube-from-tmdb.js [backup.json] [--dry-run]
 * Default: backups/firestore-backup-migrated.json
 * Requires: TMDB_API_KEY in .env
 * Report: backups/backfill-youtube-from-tmdb-report.txt
 *
 * Then: node scripts/restore-from-backup.js <backup>
 */
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import https from "https";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const DELAY_MS = 260;

function pickYoutubeTrailerKey(results) {
  const r = results || [];
  const preferred = (t) => r.find((v) => v.site === "YouTube" && v.key && v.type === t);
  return (
    preferred("Trailer") ||
    preferred("Teaser") ||
    r.find((v) => v.site === "YouTube" && v.key && (v.type === "Clip" || v.type === "Featurette")) ||
    r.find((v) => v.site === "YouTube" && v.key)
  )?.key || null;
}

function youtubeIdFromDetail(d) {
  return pickYoutubeTrailerKey(d.videos?.results);
}

function numTmdbId(m) {
  const t = m?.tmdbId;
  if (t == null || t === "") return null;
  const n = Number(t);
  return Number.isNaN(n) ? null : n;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(data);
            if (res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode}`));
              return;
            }
            if (j.success === false) {
              reject(new Error(j.status_message || "TMDB error"));
              return;
            }
            resolve(j);
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

function formatMovie(d) {
  if (!d?.id) return null;
  return { youtubeId: youtubeIdFromDetail(d) };
}

function formatTv(d) {
  if (!d?.id) return null;
  return { youtubeId: youtubeIdFromDetail(d) };
}

async function fetchYoutubeOnlyByTmdbId(id, apiKey, hint) {
  const base = `https://api.themoviedb.org/3`;
  const v = "append_to_response=videos";
  const movieUrl = `${base}/movie/${id}?${v}&api_key=${encodeURIComponent(apiKey)}`;
  const tvUrl = `${base}/tv/${id}?${v}&api_key=${encodeURIComponent(apiKey)}`;

  if (hint === "tv") {
    try {
      const d = await fetchJson(tvUrl);
      return formatTv(d);
    } catch {
      return null;
    }
  }
  if (hint === "movie") {
    try {
      const d = await fetchJson(movieUrl);
      return formatMovie(d);
    } catch {
      return null;
    }
  }
  // No hint: same id can be movie or TV. Do not stop at movie when it has no trailer,
  // or we never try /tv/{id} (formatMovie is always truthy when the request succeeds).
  let movieD = null;
  try {
    movieD = await fetchJson(movieUrl);
    const m = formatMovie(movieD);
    if (m?.youtubeId) return m;
  } catch {
    movieD = null;
  }
  try {
    const tvD = await fetchJson(tvUrl);
    return formatTv(tvD);
  } catch {
    return movieD ? formatMovie(movieD) : null;
  }
}

function walkAllItems(backup, fn) {
  const cat = backup.catalog?.movies?.items;
  if (Array.isArray(cat)) {
    for (let i = 0; i < cat.length; i++) fn(cat, i);
  }
  for (const doc of Object.values(backup.users || {})) {
    if (!Array.isArray(doc?.items)) continue;
    for (let i = 0; i < doc.items.length; i++) fn(doc.items, i);
  }
  for (const doc of Object.values(backup.sharedLists || {})) {
    if (!Array.isArray(doc?.items)) continue;
    for (let i = 0; i < doc.items.length; i++) fn(doc.items, i);
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

  const hintById = new Map();
  walkAllItems(backup, (arr, i) => {
    const m = arr[i];
    const id = numTmdbId(m);
    if (id == null) return;
    const h = m.tmdbMedia === "tv" || m.tmdbMedia === "movie" ? m.tmdbMedia : null;
    if (!hintById.has(id)) hintById.set(id, h);
    else if (h && !hintById.get(id)) hintById.set(id, h);
  });

  const uniqueIds = [...hintById.keys()].sort((a, b) => a - b);
  console.log(`Backup: ${backupPath}`);
  console.log(`Unique tmdbIds to fetch: ${uniqueIds.length}`);
  if (dryRun) {
    console.log("[--dry-run] No API calls or file writes.");
    process.exit(0);
  }

  const cache = new Map();
  const errors = [];
  for (const id of uniqueIds) {
    const hint = hintById.get(id);
    try {
      const meta = await fetchYoutubeOnlyByTmdbId(id, apiKey, hint);
      if (meta) cache.set(id, meta);
      else errors.push({ id, err: "no movie/tv details" });
    } catch (e) {
      errors.push({ id, err: String(e.message || e) });
    }
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  let rowsWithTrailerKey = 0;
  let rowsWithNull = 0;
  walkAllItems(backup, (arr, i) => {
    const m = arr[i];
    const next = { ...m };
    delete next.youtubeId;

    const id = numTmdbId(m);
    if (id == null) {
      next.youtubeId = null;
      rowsWithNull++;
    } else {
      const meta = cache.get(id);
      const key = meta?.youtubeId;
      if (key && String(key).trim()) {
        next.youtubeId = String(key).trim();
        rowsWithTrailerKey++;
      } else {
        next.youtubeId = null;
        rowsWithNull++;
      }
    }
    arr[i] = next;
  });

  backup.exportedAt = new Date().toISOString();
  const reportPath = join(rootDir, "backups", "backfill-youtube-from-tmdb-report.txt");
  const lines = [
    `backfill-youtube-from-tmdb`,
    `Generated: ${backup.exportedAt}`,
    `Backup: ${backupPath}`,
    ``,
    `Unique tmdbIds fetched: ${uniqueIds.length}`,
    `TMDB OK: ${cache.size}, errors: ${errors.length}`,
    `Rows: youtubeId = real YouTube key: ${rowsWithTrailerKey}`,
    `Rows: youtubeId = null (no trailer): ${rowsWithNull}`,
    ``,
  ];
  if (errors.length) {
    lines.push("Fetch failures (first 40):");
    errors.slice(0, 40).forEach((x) => lines.push(`  tmdbId ${x.id}: ${x.err}`));
  }

  writeFileSync(backupPath, JSON.stringify(backup, null, 2), "utf-8");
  writeFileSync(reportPath, lines.join("\n"), "utf-8");
  console.log(lines.join("\n"));
  console.log(`\nWrote ${backupPath}`);
  console.log(`Report: ${reportPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
