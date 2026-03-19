/**
 * Copy imdbId from catalog into user and shared-list items where missing.
 * Catalog (catalog.movies.items) is the source of truth; match key = title|year.
 *
 * Run: node scripts/sync-imdb-from-catalog.js [backup.json] [--dry-run]
 * Default: backups/firestore-backup-migrated.json
 *
 * No API keys required. Writes report to backups/sync-imdb-from-catalog-report.txt
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

function movieKey(m) {
  return `${m.title}|${m.year ?? ""}`;
}

/**
 * Build lookup: exact key -> imdbId, plus optional title+normYear for loose match.
 */
function buildCatalogIndex(catalogItems) {
  const byKey = new Map();
  const byTitleYear = new Map(); // "lowercase title|year" -> imdbId (last wins if dupes)

  for (const m of catalogItems) {
    if (!m?.imdbId) continue;
    const id = String(m.imdbId).startsWith("tt") ? m.imdbId : `tt${m.imdbId}`;
    byKey.set(movieKey(m), id);

    const t = String(m.title || "")
      .trim()
      .toLowerCase();
    const y = m.year == null || m.year === "" ? "" : String(m.year);
    byTitleYear.set(`${t}|${y}`, id);
  }

  return { byKey, byTitleYear };
}

function findImdbForItem(m, index) {
  const exact = movieKey(m);
  if (index.byKey.has(exact)) return { imdbId: index.byKey.get(exact), how: "exact" };

  const t = String(m.title || "")
    .trim()
    .toLowerCase();
  const y = m.year == null || m.year === "" ? "" : String(m.year);
  const looseKey = `${t}|${y}`;
  if (index.byTitleYear.has(looseKey)) {
    return { imdbId: index.byTitleYear.get(looseKey), how: "normalized-title+year" };
  }

  return null;
}

function syncItemsArray(items, index, stats, context) {
  if (!Array.isArray(items)) return;
  for (let i = 0; i < items.length; i++) {
    const m = items[i];
    if (!m || m.imdbId) continue;
    const found = findImdbForItem(m, index);
    if (found) {
      m.imdbId = found.imdbId;
      stats.filled++;
      stats.byContext[context] = (stats.byContext[context] || 0) + 1;
    } else {
      stats.stillMissing.push({
        context,
        index: i,
        title: m.title,
        year: m.year,
        key: movieKey(m),
      });
    }
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

  const catalogItems = backup.catalog?.movies?.items;
  if (!Array.isArray(catalogItems)) {
    console.error("Missing catalog.movies.items");
    process.exit(1);
  }

  const index = buildCatalogIndex(catalogItems);

  const catalogMissing = catalogItems.filter((m) => !m?.imdbId);
  const stats = {
    filled: 0,
    byContext: {},
    stillMissing: [],
  };

  for (const [uid, doc] of Object.entries(backup.users || {})) {
    syncItemsArray(doc.items, index, stats, `user:${uid}`);
  }
  for (const [listId, doc] of Object.entries(backup.sharedLists || {})) {
    syncItemsArray(doc.items, index, stats, `shared:${listId}`);
  }

  const reportPath = join(rootDir, "backups", "sync-imdb-from-catalog-report.txt");
  const lines = [
    `sync-imdb-from-catalog`,
    `Generated: ${new Date().toISOString()}`,
    `Backup: ${backupPath}`,
    dryRun ? "DRY RUN (no file written)" : "",
    ``,
    `Catalog rows without imdbId (should fix manually): ${catalogMissing.length}`,
    `imdbId filled from catalog: ${stats.filled}`,
    `By area: ${JSON.stringify(stats.byContext)}`,
    `Still missing imdbId (not in catalog by title|year): ${stats.stillMissing.length}`,
    ``,
  ];

  if (catalogMissing.length) {
    lines.push(`Catalog missing imdbId (first 40):`);
    catalogMissing.slice(0, 40).forEach((m) =>
      lines.push(`  - ${movieKey(m)}`)
    );
    lines.push(``);
  }

  if (stats.stillMissing.length) {
    lines.push(`Rows still without imdbId (first 80):`);
    stats.stillMissing.slice(0, 80).forEach((x) =>
      lines.push(`  [${x.context}] ${x.key}`)
    );
    if (stats.stillMissing.length > 80) lines.push(`  ... and ${stats.stillMissing.length - 80} more`);
  }

  console.log(lines.filter(Boolean).join("\n"));

  if (!dryRun) {
    backup.exportedAt = new Date().toISOString();
    writeFileSync(backupPath, JSON.stringify(backup, null, 2), "utf-8");
    writeFileSync(reportPath, lines.filter(Boolean).join("\n"), "utf-8");
    console.log(`\nWrote ${backupPath}`);
    console.log(`Report: ${reportPath}`);
  } else {
    writeFileSync(reportPath, lines.filter(Boolean).join("\n"), "utf-8");
    console.log(`\nReport (dry-run): ${reportPath}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
