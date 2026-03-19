/**
 * Append any item that appears in users or sharedLists but not in catalog/movies/items.
 * Picks the richest copy per title|year (imdb/tmdb/youtube/thumb/etc.).
 *
 * Run: node scripts/sync-missing-items-to-catalog.js [backup.json] [--dry-run]
 * Default: backups/firestore-backup-migrated.json
 * Report: backups/sync-missing-to-catalog-report.txt
 *
 * Then restore: node scripts/restore-from-backup.js <backup>
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

function movieKey(m) {
  return `${m?.title ?? ""}|${m.year ?? ""}`;
}

/** Strip UI-only fields; catalog rows match add-from-imdb shape. */
function cleanForCatalog(m) {
  if (!m || typeof m !== "object") return null;
  const { status, ...rest } = m;
  return rest;
}

function scoreItem(m) {
  if (!m) return -1;
  let s = 0;
  if (m.imdbId) s += 100;
  if (m.tmdbId != null && m.tmdbId !== "") s += 50;
  if (m.youtubeId) s += 30;
  if (m.thumb) s += 10;
  if (m.genre) s += 5;
  if (m.type) s += 2;
  if (Array.isArray(m.services) && m.services.length) s += Math.min(m.services.length, 10);
  if (m.servicesByRegion && typeof m.servicesByRegion === "object") s += 3;
  return s;
}

/** Combine several copies of the same title|year; fill gaps from any candidate. */
function mergeCatalogCandidates(candidates) {
  const cleaned = candidates.map(cleanForCatalog).filter(Boolean);
  if (cleaned.length === 0) return null;
  const sorted = [...cleaned].sort((a, b) => scoreItem(b) - scoreItem(a));
  const base = { ...sorted[0] };
  for (const o of sorted.slice(1)) {
    if (!base.imdbId && o.imdbId) base.imdbId = o.imdbId;
    if ((base.tmdbId == null || base.tmdbId === "") && o.tmdbId != null && o.tmdbId !== "")
      base.tmdbId = o.tmdbId;
    if (!base.tmdbMedia && o.tmdbMedia) base.tmdbMedia = o.tmdbMedia;
    if (!base.youtubeId && o.youtubeId) base.youtubeId = o.youtubeId;
    if (!base.thumb && o.thumb) base.thumb = o.thumb;
    if (!base.genre && o.genre) base.genre = o.genre;
    if (!base.type && o.type) base.type = o.type;
    if (base.year == null && o.year != null) base.year = o.year;
    if ((!base.services || base.services.length === 0) && Array.isArray(o.services) && o.services.length)
      base.services = [...o.services];
    if (!base.servicesByRegion && o.servicesByRegion) base.servicesByRegion = o.servicesByRegion;
  }
  return base;
}

function walkItems(backup, fn) {
  for (const doc of Object.values(backup.users || {})) {
    if (!doc || typeof doc !== "object") continue;
    if (Array.isArray(doc.items)) {
      for (const m of doc.items) fn(m, "user");
    }
  }
  for (const [listId, doc] of Object.entries(backup.sharedLists || {})) {
    if (!doc || typeof doc !== "object") continue;
    if (Array.isArray(doc.items)) {
      for (const m of doc.items) fn(m, `shared:${listId}`);
    }
  }
}

function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--dry-run");
  const dryRun = process.argv.includes("--dry-run");

  const defaultPath = join(rootDir, "backups", "firestore-backup-migrated.json");
  const altPath = join(rootDir, "backups", "firestore-backup.json");
  const backupPath =
    args[0] && !args[0].startsWith("--")
      ? args[0]
      : existsSync(defaultPath)
        ? defaultPath
        : altPath;

  if (!existsSync(backupPath)) {
    console.error("Missing:", backupPath);
    process.exit(1);
  }

  const backup = JSON.parse(readFileSync(backupPath, "utf-8"));
  const catItems = backup.catalog?.movies?.items;
  if (!Array.isArray(catItems)) {
    console.error("backup.catalog.movies.items must be an array");
    process.exit(1);
  }

  const catalogKeys = new Set();
  for (const m of catItems) {
    if (m && (m.title != null || m.year != null)) catalogKeys.add(movieKey(m));
  }

  /** @type {Map<string, { candidates: object[], sources: string[] }>} */
  const byKey = new Map();

  walkItems(backup, (m, where) => {
    if (!m || (m.title == null && m.year == null)) return;
    const key = movieKey(m);
    if (!key.replace(/\|/g, "").trim()) return;
    const cleaned = cleanForCatalog(m);
    if (!cleaned) return;
    let prev = byKey.get(key);
    if (!prev) {
      prev = { candidates: [], sources: [] };
      byKey.set(key, prev);
    }
    prev.candidates.push(m);
    if (!prev.sources.includes(where)) prev.sources.push(where);
  });

  const toAdd = [];
  for (const [key, { candidates, sources }] of byKey) {
    if (catalogKeys.has(key)) continue;
    const item = mergeCatalogCandidates(candidates);
    if (!item) continue;
    toAdd.push({ key, item, sources });
  }

  toAdd.sort((a, b) => a.key.localeCompare(b.key));

  const lines = [
    `sync-missing-items-to-catalog`,
    `Backup: ${backupPath}`,
    `Dry run: ${dryRun}`,
    `Generated: ${new Date().toISOString()}`,
    ``,
    `Catalog had ${catItems.length} rows, ${catalogKeys.size} unique keys.`,
    `Missing from catalog (will add): ${toAdd.length}`,
    ``,
  ];

  for (const { key, item, sources } of toAdd) {
    lines.push(`+ ${JSON.stringify(key)}  ← ${sources.join(", ")}`);
    lines.push(`    title=${JSON.stringify(item.title)} year=${item.year ?? "null"}`);
  }

  if (!dryRun && toAdd.length > 0) {
    for (const { item } of toAdd) {
      catItems.push(item);
    }
    backup.exportedAt = new Date().toISOString();
    writeFileSync(backupPath, JSON.stringify(backup, null, 2) + "\n", "utf-8");
    lines.push(``, `Wrote ${backupPath}`);
  } else if (dryRun) {
    lines.push(``, `[--dry-run] No file written.`);
  } else {
    lines.push(``, `Nothing to add.`);
  }

  const reportPath = join(rootDir, "backups", "sync-missing-to-catalog-report.txt");
  const body = lines.join("\n") + "\n";
  writeFileSync(reportPath, body, "utf-8");

  console.log(body);
  console.log(`Report: ${reportPath}`);
}

main();
