/**
 * Migrate titleRegistry (and embedded list rows) from stored YouTube trailer
 * to IMDb-first: youtubeId → null, thumb from OMDb poster when available.
 *
 * Run: node scripts/migrate-youtube-to-imdb-trailer.js
 * Requires: OMDB_API_KEY in .env
 * Input/Output: backups/firestore-backup-migrated.json
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import https from "https";
import { isPlayableYoutubeTrailerId } from "../lib/youtube-trailer-id.js";
import { listKey } from "../lib/registry-id.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const backupPath = join(rootDir, "backups", "firestore-backup-migrated.json");

const DELAY_MS = 260;

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

async function fetchOMDbPoster(imdbId) {
  const key = process.env.OMDB_API_KEY;
  if (!key) throw new Error("OMDB_API_KEY missing");
  const id = String(imdbId).startsWith("tt") ? imdbId : `tt${imdbId}`;
  const url = `https://www.omdbapi.com/?i=${encodeURIComponent(id)}&apikey=${key}`;
  const json = await fetchJson(url);
  if (json.Response === "False") return null;
  const p = json.Poster;
  if (!p || p === "N/A") return null;
  return p;
}

function isYoutubeThumb(t) {
  return String(t || "").includes("img.youtube.com") || String(t || "").includes("ytimg.com");
}

function applyTrailerMigration(m, posterUrl) {
  m.youtubeId = null;
  if (posterUrl) {
    m.thumb = posterUrl;
  } else if (isYoutubeThumb(m.thumb)) {
    delete m.thumb;
  }
}

function snapshotForSync(m) {
  const s = { youtubeId: m.youtubeId };
  s.thumb = m.thumb === undefined ? null : m.thumb;
  return s;
}

function isBareRegistryRef(m) {
  if (!m || typeof m !== "object") return true;
  const k = Object.keys(m);
  return k.length === 1 && k[0] === "registryId";
}

function syncItemFromCanonical(m, byKey, byRegistryId) {
  if (m.registryId && byRegistryId.has(m.registryId)) {
    const canon = byRegistryId.get(m.registryId);
    m.youtubeId = canon.youtubeId;
    if (canon.thumb === null || canon.thumb === undefined) delete m.thumb;
    else m.thumb = canon.thumb;
    return true;
  }
  const k = listKey(m);
  const canon = byKey.get(k);
  if (!canon) return false;
  m.youtubeId = canon.youtubeId;
  if (canon.thumb === null || canon.thumb === undefined) delete m.thumb;
  else m.thumb = canon.thumb;
  return true;
}

/**
 * Embedded list rows not covered by titleRegistry migration: OMDb + null youtubeId, then sync.
 */
async function migrateAndSyncUserSharedItems(backup, byKey, byRegistryId, report) {
  const listRows = [];
  if (backup.users) {
    for (const doc of Object.values(backup.users)) {
      if (!doc?.items || !Array.isArray(doc.items)) continue;
      for (const m of doc.items) listRows.push(m);
    }
  }
  if (backup.sharedLists) {
    for (const doc of Object.values(backup.sharedLists)) {
      if (!doc?.items || !Array.isArray(doc.items)) continue;
      for (const m of doc.items) listRows.push(m);
    }
  }
  if (backup.userPersonalLists && typeof backup.userPersonalLists === "object") {
    for (const lists of Object.values(backup.userPersonalLists)) {
      if (!lists || typeof lists !== "object") continue;
      for (const doc of Object.values(lists)) {
        if (!doc?.items || !Array.isArray(doc.items)) continue;
        for (const m of doc.items) listRows.push(m);
      }
    }
  }

  let orphans = 0;
  for (const m of listRows) {
    if (isBareRegistryRef(m)) continue;
    if (!m.imdbId || !isPlayableYoutubeTrailerId(m.youtubeId)) continue;
    const k = listKey(m);
    if (byKey.has(k) || (m.registryId && byRegistryId.has(m.registryId))) continue;
    try {
      const poster = await fetchOMDbPoster(m.imdbId);
      applyTrailerMigration(m, poster);
      byKey.set(k, snapshotForSync(m));
      orphans++;
      if (poster) report.posterOk++;
      else report.posterFail++;
    } catch (e) {
      applyTrailerMigration(m, null);
      byKey.set(k, snapshotForSync(m));
      orphans++;
      report.posterFail++;
      report.errors.push({
        title: m.title,
        year: m.year,
        err: `orphan: ${String(e.message || e)}`,
      });
    }
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  let synced = 0;
  for (const m of listRows) {
    if (syncItemFromCanonical(m, byKey, byRegistryId)) synced++;
  }
  return { orphans, synced };
}

async function main() {
  const apiKey = process.env.OMDB_API_KEY;
  if (!apiKey) {
    console.error("Set OMDB_API_KEY in .env");
    process.exit(1);
  }

  const backup = JSON.parse(readFileSync(backupPath, "utf-8"));
  const tr = backup.titleRegistry || {};
  const registryRows = Object.entries(tr)
    .map(([rid, row]) => ({ rid, m: row }))
    .filter((x) => x.m && typeof x.m === "object");

  const toMigrate = registryRows.filter((x) => x.m.imdbId && isPlayableYoutubeTrailerId(x.m.youtubeId));
  console.log(`titleRegistry docs with YouTube trailer + imdbId: ${toMigrate.length}`);

  const report = { migrated: 0, posterOk: 0, posterFail: 0, errors: [] };
  const byKey = new Map();
  const byRegistryId = new Map();

  for (const { rid, m } of toMigrate) {
    try {
      const poster = await fetchOMDbPoster(m.imdbId);
      applyTrailerMigration(m, poster);
      const snap = snapshotForSync(m);
      byKey.set(listKey({ title: m.title, year: m.year }), snap);
      byRegistryId.set(rid, snap);
      report.migrated++;
      if (poster) report.posterOk++;
      else report.posterFail++;
    } catch (e) {
      applyTrailerMigration(m, null);
      const snap = snapshotForSync(m);
      byKey.set(listKey({ title: m.title, year: m.year }), snap);
      byRegistryId.set(rid, snap);
      report.migrated++;
      report.posterFail++;
      report.errors.push({ title: m.title, year: m.year, err: String(e.message || e) });
    }
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  const { orphans, synced } = await migrateAndSyncUserSharedItems(backup, byKey, byRegistryId, report);
  backup.exportedAt = new Date().toISOString();
  writeFileSync(backupPath, JSON.stringify(backup, null, 2), "utf-8");

  const reportPath = join(rootDir, "backups", "youtube-to-imdb-migration-report.txt");
  const lines = [
    `YouTube → IMDb-first trailer migration (titleRegistry)`,
    `Generated: ${new Date().toISOString()}`,
    ``,
    `titleRegistry: set youtubeId to null for ${report.migrated} docs (had real YouTube id + imdbId).`,
    `Embedded list-only titles migrated: ${orphans}`,
    `OMDb poster used for thumb: ${report.posterOk}`,
    `No OMDb poster (thumb cleared if was YouTube): ${report.posterFail}`,
    `List item rows synced from canonical: ${synced}`,
    ``,
  ];
  if (report.errors.length) {
    lines.push(`OMDb errors (first 20):`);
    report.errors.slice(0, 20).forEach((x) => lines.push(`  - ${x.title} (${x.year}): ${x.err}`));
  }
  writeFileSync(reportPath, lines.join("\n"), "utf-8");

  console.log(lines.join("\n"));
  console.log(`\nWrote ${backupPath}`);
  console.log(`Report: ${reportPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
