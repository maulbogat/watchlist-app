/**
 * For every item with tmdbId, refresh title, year, type (movie/show), genre from TMDB
 * /movie/{id} or /tv/{id}. Uses tmdbMedia when set; otherwise tries movie then TV.
 *
 * Run: node scripts/sync-metadata-from-tmdb-id.js [backup.json] [--dry-run]
 * Default: backups/firestore-backup-migrated.json
 *
 * Requires: TMDB_API_KEY in .env
 * Report: backups/sync-metadata-from-tmdb-report.txt
 *
 * Renames movieKey in watched/maybeLater/archive/removed when title/year change.
 */
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import https from "https";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const DELAY_MS = 260;

function movieKey(m) {
  return `${m.title}|${m.year ?? ""}`;
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
  let year = null;
  if (d.release_date && String(d.release_date).length >= 4) {
    year = parseInt(String(d.release_date).slice(0, 4), 10);
  }
  if (Number.isNaN(year)) year = null;
  const genres = (d.genres || []).map((g) => g.name).filter(Boolean);
  return {
    title: d.title || d.original_title || "",
    year,
    type: "movie",
    genre: genres.join(" / "),
    tmdbMedia: "movie",
  };
}

function formatTv(d) {
  if (!d?.id) return null;
  let year = null;
  if (d.first_air_date && String(d.first_air_date).length >= 4) {
    year = parseInt(String(d.first_air_date).slice(0, 4), 10);
  }
  if (Number.isNaN(year)) year = null;
  const genres = (d.genres || []).map((g) => g.name).filter(Boolean);
  return {
    title: d.name || d.original_name || "",
    year,
    type: "show",
    genre: genres.join(" / "),
    tmdbMedia: "tv",
  };
}

async function fetchDetailsByTmdbId(id, apiKey, hint) {
  const base = `https://api.themoviedb.org/3`;
  const movieUrl = `${base}/movie/${id}?api_key=${encodeURIComponent(apiKey)}`;
  const tvUrl = `${base}/tv/${id}?api_key=${encodeURIComponent(apiKey)}`;

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
  try {
    const d = await fetchJson(movieUrl);
    const m = formatMovie(d);
    if (m) return m;
  } catch {
    /* try tv */
  }
  try {
    const d = await fetchJson(tvUrl);
    return formatTv(d);
  } catch {
    return null;
  }
}

function replaceKeyEverywhere(backup, oldKey, newKey) {
  if (!oldKey || oldKey === newKey) return;
  const userFields = ["watched", "maybeLater", "archive"];
  const sharedFields = ["removed", "watched", "maybeLater", "archive"];

  for (const doc of Object.values(backup.users || {})) {
    for (const f of userFields) {
      if (!Array.isArray(doc[f])) continue;
      doc[f] = doc[f].map((k) => (k === oldKey ? newKey : k));
    }
  }
  for (const doc of Object.values(backup.sharedLists || {})) {
    for (const f of sharedFields) {
      if (!Array.isArray(doc[f])) continue;
      doc[f] = doc[f].map((k) => (k === oldKey ? newKey : k));
    }
  }
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

  /** @type {Map<number, 'movie'|'tv'|null>} */
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
  console.log(`Unique tmdbIds to refresh: ${uniqueIds.length}`);
  if (dryRun) {
    console.log("[--dry-run] Exiting before TMDB API calls and file writes.");
    process.exit(0);
  }

  const cache = new Map();
  const errors = [];
  for (const id of uniqueIds) {
    const hint = hintById.get(id);
    try {
      const meta = await fetchDetailsByTmdbId(id, apiKey, hint);
      if (meta) cache.set(id, meta);
      else errors.push({ id, err: "no movie/tv details" });
    } catch (e) {
      errors.push({ id, err: String(e.message || e) });
    }
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  let rowsUpdated = 0;
  let keyRenames = 0;
  walkAllItems(backup, (arr, i) => {
    const m = arr[i];
    const id = numTmdbId(m);
    if (id == null) return;
    const meta = cache.get(id);
    if (!meta) return;

    const oldKey = movieKey(m);
    const next = {
      ...m,
      title: meta.title,
      year: meta.year,
      type: meta.type,
      genre: meta.genre || "",
      tmdbMedia: meta.tmdbMedia,
    };
    const newKey = movieKey(next);
    if (oldKey !== newKey) {
      replaceKeyEverywhere(backup, oldKey, newKey);
      keyRenames++;
    }
    arr[i] = next;
    rowsUpdated++;
  });

  backup.exportedAt = new Date().toISOString();
  const reportPath = join(rootDir, "backups", "sync-metadata-from-tmdb-report.txt");
  const lines = [
    `sync-metadata-from-tmdb-id`,
    `Generated: ${backup.exportedAt}`,
    `Backup: ${backupPath}`,
    ``,
    `Unique tmdbIds: ${uniqueIds.length}`,
    `TMDB detail fetches OK: ${cache.size}`,
    `Fetch failures: ${errors.length}`,
    `Item rows updated: ${rowsUpdated}`,
    `movieKey renames: ${keyRenames}`,
    ``,
  ];
  if (errors.length) {
    lines.push("Failures (first 40):");
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
