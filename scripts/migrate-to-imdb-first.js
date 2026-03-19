/**
 * Migrate catalog to "IMDb first" approach (YouTube backup).
 *
 * 1. Creates backups/youtube-source-backup.json - items that use YouTube as source
 *    or lack imdbId
 * 2. Tries to migrate: OMDb search by title+year to add imdbId
 * 3. Outputs migration report
 *
 * Run: node scripts/migrate-to-imdb-first.js [input-path]
 *   input-path: backups/firestore-backup.json (default) or watchlist-backup.json
 *
 * Requires: OMDB_API_KEY in .env
 * Optional: --dry-run (no writes), --write (update Firestore catalog)
 */
import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import https from "https";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
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

async function omdbSearchByTitle(title, year) {
  const apiKey = process.env.OMDB_API_KEY;
  if (!apiKey) return null;
  const params = new URLSearchParams({ s: title, apikey: apiKey });
  if (year) params.set("y", String(year));
  const url = `https://www.omdbapi.com/?${params}`;
  try {
    const json = await fetchJson(url);
    if (json.Response === "True" && Array.isArray(json.Search) && json.Search.length > 0) {
      return json.Search[0].imdbID || null;
    }
  } catch (_) {}
  const exactParams = new URLSearchParams({ t: title, apikey: apiKey });
  if (year) exactParams.set("y", String(year));
  try {
    const exact = await fetchJson(`https://www.omdbapi.com/?${exactParams}`);
    if (exact.Response === "True" && exact.imdbID) return exact.imdbID;
  } catch (_) {}
  return null;
}

function movieKey(m) {
  return `${m.title}|${m.year ?? ""}`;
}

function usesYoutubeForTrailer(m) {
  const id = m.youtubeId;
  return id && id !== "SEARCH" && id.length > 0;
}

function usesYoutubeForThumb(m) {
  const t = String(m.thumb || "");
  return t.includes("img.youtube.com") || t.includes("ytimg.com");
}

function lacksImdbId(m) {
  const id = m.imdbId;
  return !id || (typeof id === "string" && id.trim() === "");
}

function needsMigration(m) {
  return lacksImdbId(m) || usesYoutubeForTrailer(m) || usesYoutubeForThumb(m);
}

function loadItems(inputPath) {
  const raw = JSON.parse(readFileSync(inputPath, "utf-8"));
  if (Array.isArray(raw.items)) {
    return raw.items;
  }
  if (raw.catalog?.movies?.items) {
    return raw.catalog.movies.items;
  }
  throw new Error(`Unknown format in ${inputPath}`);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const writeFirestore = args.includes("--write");
  const inputPath = args.find((a) => !a.startsWith("--")) || join(rootDir, "backups", "firestore-backup.json");

  const apiKey = process.env.OMDB_API_KEY;
  if (!apiKey) {
    console.error("Set OMDB_API_KEY in .env");
    process.exit(1);
  }

  console.log(`Loading from ${inputPath}...`);
  const items = loadItems(inputPath);
  console.log(`Total items: ${items.length}`);

  const toMigrate = items.filter(needsMigration);
  const alreadyImdb = items.filter((m) => !needsMigration(m));

  console.log(`\nItems needing migration (YouTube source or lack imdbId): ${toMigrate.length}`);

  mkdirSync(join(rootDir, "backups"), { recursive: true });
  const backupPath = join(rootDir, "backups", "youtube-source-backup.json");
  writeFileSync(
    backupPath,
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        count: toMigrate.length,
        items: toMigrate,
      },
      null,
      2
    ),
    "utf-8"
  );
  console.log(`Backup written to ${backupPath}`);

  const report = {
    migrated: [],
    failed: [],
    skipped: [],
  };

  const migratedItems = [...items];
  const keyToIndex = new Map();
  items.forEach((m, i) => keyToIndex.set(movieKey(m), i));

  console.log(`\nMigrating (OMDb search by title+year)...`);
  for (let i = 0; i < toMigrate.length; i++) {
    const m = toMigrate[i];
    const key = movieKey(m);
    const idx = keyToIndex.get(key);
    if (idx === undefined) continue;

    if (!lacksImdbId(m)) {
      report.skipped.push({ title: m.title, year: m.year, reason: "already has imdbId" });
      continue;
    }

    const imdbId = await omdbSearchByTitle(m.title, m.year);
    if (imdbId) {
      const norm = String(imdbId).startsWith("tt") ? imdbId : `tt${imdbId}`;
      migratedItems[idx] = { ...migratedItems[idx], imdbId: norm };
      report.migrated.push({ title: m.title, year: m.year, imdbId: norm });
      if ((i + 1) % 10 === 0) process.stdout.write(".");
    } else {
      report.failed.push({ title: m.title, year: m.year, reason: "OMDb search returned no match" });
    }

    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(" done.");

  const reportPath = join(rootDir, "backups", "migrate-to-imdb-report.txt");
  const reportLines = [
    `IMDb-first migration report`,
    `Generated: ${new Date().toISOString()}`,
    `Input: ${inputPath}`,
    ``,
    `=== Summary ===`,
    `Total items: ${items.length}`,
    `Already IMDb-ready: ${alreadyImdb.length}`,
    `Needed migration: ${toMigrate.length}`,
    `Migrated (imdbId added): ${report.migrated.length}`,
    `Failed (no OMDb match): ${report.failed.length}`,
    `Skipped (had imdbId): ${report.skipped.length}`,
    ``,
    `=== Still uses YouTube ===`,
  ];

  const stillYoutubeTrailer = migratedItems.filter(usesYoutubeForTrailer);
  const stillYoutubeThumb = migratedItems.filter(usesYoutubeForThumb);
  const stillMissingImdb = migratedItems.filter(lacksImdbId);
  const stillMissingTrailer = migratedItems.filter((m) => !m.youtubeId || m.youtubeId === "SEARCH");
  const stillMissingThumb = migratedItems.filter(
    (m) => !m.thumb || (m.youtubeId === "SEARCH" && !m.thumb)
  );

  reportLines.push(`Trailer from YouTube: ${stillYoutubeTrailer.length}`);
  if (stillYoutubeTrailer.length <= 30) {
    stillYoutubeTrailer.forEach((m) => reportLines.push(`  - ${m.title} (${m.year ?? "—"})`));
  } else {
    stillYoutubeTrailer.slice(0, 30).forEach((m) => reportLines.push(`  - ${m.title} (${m.year ?? "—"})`));
    reportLines.push(`  ... and ${stillYoutubeTrailer.length - 30} more`);
  }

  reportLines.push(``, `Thumb from YouTube: ${stillYoutubeThumb.length}`);
  if (stillYoutubeThumb.length <= 30) {
    stillYoutubeThumb.forEach((m) => reportLines.push(`  - ${m.title} (${m.year ?? "—"})`));
  } else {
    stillYoutubeThumb.slice(0, 30).forEach((m) => reportLines.push(`  - ${m.title} (${m.year ?? "—"})`));
    reportLines.push(`  ... and ${stillYoutubeThumb.length - 30} more`);
  }

  reportLines.push(
    ``,
    `=== Still missing ===`,
    `Missing imdbId: ${stillMissingImdb.length}`,
    `Missing trailer (youtubeId empty/SEARCH): ${stillMissingTrailer.length}`,
    `Missing thumb: ${stillMissingThumb.length}`
  );

  if (stillMissingImdb.length > 0 && stillMissingImdb.length <= 50) {
    reportLines.push(``, `Items still without imdbId:`);
    stillMissingImdb.forEach((m) => reportLines.push(`  - ${m.title} (${m.year ?? "—"})`));
  }

  if (stillMissingTrailer.length > 0 && stillMissingTrailer.length <= 30) {
    reportLines.push(``, `Items missing trailer:`);
    stillMissingTrailer.forEach((m) => reportLines.push(`  - ${m.title} (${m.year ?? "—"})`));
  } else if (stillMissingTrailer.length > 30) {
    reportLines.push(``, `Items missing trailer (first 30):`);
    stillMissingTrailer.slice(0, 30).forEach((m) => reportLines.push(`  - ${m.title} (${m.year ?? "—"})`));
  }

  if (stillMissingThumb.length > 0 && stillMissingThumb.length <= 30) {
    reportLines.push(``, `Items missing thumb:`);
    stillMissingThumb.forEach((m) => reportLines.push(`  - ${m.title} (${m.year ?? "—"})`));
  }

  if (report.failed.length > 0 && report.failed.length <= 50) {
    reportLines.push(``, `OMDb search failed (no match):`);
    report.failed.forEach((f) => reportLines.push(`  - ${f.title} (${f.year ?? "—"})`));
  }

  reportLines.push(``, `Backup of YouTube-source items: backups/youtube-source-backup.json`);

  writeFileSync(reportPath, reportLines.join("\n"), "utf-8");
  console.log(`Report written to ${reportPath}`);

  if (dryRun) {
    console.log(`\n[DRY RUN] No writes. Run without --dry-run to save migrated data.`);
    return;
  }

  const migratedBackupPath = join(rootDir, "backups", "firestore-backup-migrated.json");
  const inputRaw = readFileSync(inputPath, "utf-8");
  let backupObj;
  try {
    backupObj = JSON.parse(inputRaw);
  } catch (_) {
    console.log("\nCould not parse input. Skipping migrated backup write.");
    backupObj = null;
  }

  if (backupObj?.catalog?.movies?.items) {
    backupObj.catalog.movies.items = migratedItems;
    backupObj.exportedAt = new Date().toISOString();
    writeFileSync(migratedBackupPath, JSON.stringify(backupObj, null, 2), "utf-8");
    console.log(`Migrated Firestore backup written to ${migratedBackupPath}`);
  } else if (backupObj?.items) {
    backupObj.items = migratedItems;
    backupObj.exportedAt = new Date().toISOString();
    backupObj.count = migratedItems.length;
    writeFileSync(migratedBackupPath, JSON.stringify(backupObj, null, 2), "utf-8");
    console.log(`Migrated backup written to ${migratedBackupPath}`);
  } else {
    writeFileSync(
      migratedBackupPath,
      JSON.stringify({ exportedAt: new Date().toISOString(), count: migratedItems.length, items: migratedItems }, null, 2),
      "utf-8"
    );
    console.log(`Migrated data written to ${migratedBackupPath}`);
  }

  if (writeFirestore) {
    const { initializeApp, cert } = await import("firebase-admin/app");
    const { getFirestore } = await import("firebase-admin/firestore");
    const keyPath = join(rootDir, "serviceAccountKey.json");
    let key;
    try {
      if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        key = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, "base64").toString("utf-8"));
      } else {
        key = JSON.parse(readFileSync(keyPath, "utf-8"));
      }
    } catch (e) {
      console.error("Need Firebase credentials for --write. See backup-firestore.js.");
      process.exit(1);
    }
    const app = initializeApp({ credential: cert(key) });
    const db = getFirestore(app);
    await db.collection("catalog").doc("movies").set(
      {
        items: migratedItems,
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
    console.log(`\nFirestore catalog updated.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
