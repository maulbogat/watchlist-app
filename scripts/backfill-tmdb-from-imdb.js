/**
 * Backfill all list/catalog items that have imdbId: refresh from TMDB (title, year,
 * type, genre, poster thumb, watch providers, tmdbId, YouTube trailer id).
 * IMDb id is the source of truth key; TMDB supplies everything else.
 *
 * Run: node scripts/backfill-tmdb-from-imdb.js [path/to/backup.json]
 * Default backup: backups/firestore-backup-migrated.json (or firestore-backup.json if missing)
 *
 * Requires: TMDB_API_KEY in .env
 * Optional: WATCH_REGION (default IL)
 *
 * Use --dry-run to only print counts without writing.
 * After review: restore with node scripts/restore-from-backup.js <file>
 * Or deploy data your usual way.
 */
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import https from "https";
import { isPlayableYoutubeTrailerId } from "../lib/youtube-trailer-id.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

const DELAY_MS = 280;
const TMDB_IMG = "https://image.tmdb.org/t/p/w500";

function movieKey(m) {
  return `${m.title}|${m.year ?? ""}`;
}

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

/** When TMDB returns both movie + TV for one IMDb id, never blindly prefer movie (see add-from-imdb). */
function pickTmdbFindEntry(find, itemTypeHint) {
  const movie = find.movie_results?.[0];
  const tv = find.tv_results?.[0];
  if (!movie && !tv) return { mediaType: null, id: null };
  if (!movie) return { mediaType: "tv", id: tv.id };
  if (!tv) return { mediaType: "movie", id: movie.id };
  if (itemTypeHint === "movie") return { mediaType: "movie", id: movie.id };
  if (itemTypeHint === "show") return { mediaType: "tv", id: tv.id };
  return { mediaType: "tv", id: tv.id };
}

async function enrichFromTmdb(imdbId, apiKey, watchRegion, itemTypeHint) {
  const findUrl = `https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}?external_source=imdb_id&api_key=${apiKey}`;
  const find = await fetchJson(findUrl);
  const { mediaType, id } = pickTmdbFindEntry(find, itemTypeHint);
  if (id == null || !mediaType) return null;

  const detailUrl = `https://api.themoviedb.org/3/${mediaType}/${id}?append_to_response=videos&api_key=${apiKey}`;
  const detail = await fetchJson(detailUrl);

  const posterPath = detail.poster_path;
  const thumb = posterPath ? `${TMDB_IMG}${posterPath}` : null;

  const title =
    mediaType === "movie"
      ? detail.title || detail.original_title || ""
      : detail.name || detail.original_name || "";

  let year = null;
  if (mediaType === "movie") {
    const d = detail.release_date;
    if (d && String(d).length >= 4) year = parseInt(String(d).slice(0, 4), 10);
  } else {
    const d = detail.first_air_date;
    if (d && String(d).length >= 4) year = parseInt(String(d).slice(0, 4), 10);
  }
  if (Number.isNaN(year)) year = null;

  const genres = (detail.genres || []).map((g) => g.name).filter(Boolean);
  const genre = genres.join(" / ");

  let youtubeId = pickYoutubeTrailerKey(detail.videos?.results);

  let services = [];
  if (watchRegion && String(watchRegion).length >= 2) {
    const providersUrl = `https://api.themoviedb.org/3/${mediaType}/${id}/watch/providers?api_key=${apiKey}`;
    const pdata = await fetchJson(providersUrl);
    const region = pdata.results?.[String(watchRegion).toUpperCase().slice(0, 2)];
    if (region) {
      const names = new Set();
      for (const arr of [region.flatrate, region.rent, region.buy].filter(Boolean)) {
        for (const p of arr) {
          if (p.provider_name) names.add(p.provider_name);
        }
      }
      services = [...names];
    }
  }

  return {
    tmdbId: id,
    type: mediaType === "movie" ? "movie" : "show",
    title: title || "Unknown",
    year,
    thumb,
    genre,
    youtubeId,
    services,
  };
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

function collectItemsWithImdb(backup) {
  const out = [];
  const cat = backup.catalog?.movies?.items;
  if (Array.isArray(cat)) {
    for (let i = 0; i < cat.length; i++) {
      const m = cat[i];
      if (m?.imdbId) out.push({ place: "catalog", ref: cat, index: i, m });
    }
  }
  for (const [uid, doc] of Object.entries(backup.users || {})) {
    if (!Array.isArray(doc?.items)) continue;
    for (let i = 0; i < doc.items.length; i++) {
      const m = doc.items[i];
      if (m?.imdbId) out.push({ place: "user", userId: uid, ref: doc.items, index: i, m });
    }
  }
  for (const [listId, doc] of Object.entries(backup.sharedLists || {})) {
    if (!Array.isArray(doc?.items)) continue;
    for (let i = 0; i < doc.items.length; i++) {
      const m = doc.items[i];
      if (m?.imdbId) out.push({ place: "shared", listId, ref: doc.items, index: i, m });
    }
  }
  return out;
}

/** Items that cannot be matched to TMDB (missing or invalid imdbId). */
function collectItemsWithoutValidImdb(backup) {
  const out = [];
  const push = (place, idLabel, index, m) => {
    out.push({
      place,
      idLabel,
      index,
      title: m?.title,
      year: m?.year,
      rawImdbId: m?.imdbId,
    });
  };
  const cat = backup.catalog?.movies?.items;
  if (Array.isArray(cat)) {
    for (let i = 0; i < cat.length; i++) {
      const m = cat[i];
      const id = normImdb(m?.imdbId);
      if (!/^tt\d+$/.test(id)) push("catalog", "catalog", i, m);
    }
  }
  for (const [uid, doc] of Object.entries(backup.users || {})) {
    if (!Array.isArray(doc?.items)) continue;
    for (let i = 0; i < doc.items.length; i++) {
      const m = doc.items[i];
      const id = normImdb(m?.imdbId);
      if (!/^tt\d+$/.test(id)) push("user", uid, i, m);
    }
  }
  for (const [listId, doc] of Object.entries(backup.sharedLists || {})) {
    if (!Array.isArray(doc?.items)) continue;
    for (let i = 0; i < doc.items.length; i++) {
      const m = doc.items[i];
      const id = normImdb(m?.imdbId);
      if (!/^tt\d+$/.test(id)) push("shared", listId, i, m);
    }
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const dryRun = process.argv.includes("--dry-run");

  const defaultMigrated = join(rootDir, "backups", "firestore-backup-migrated.json");
  const defaultPlain = join(rootDir, "backups", "firestore-backup.json");
  let backupPath = args[0];
  if (!backupPath) {
    backupPath = existsSync(defaultMigrated) ? defaultMigrated : defaultPlain;
  }

  const tmdbKey = process.env.TMDB_API_KEY;
  if (!tmdbKey) {
    console.error("Set TMDB_API_KEY in .env");
    process.exit(1);
  }

  const watchRegion = String(process.env.WATCH_REGION || "IL")
    .trim()
    .toUpperCase()
    .slice(0, 2);

  let backup;
  try {
    backup = JSON.parse(readFileSync(backupPath, "utf-8"));
  } catch (e) {
    console.error("Cannot read", backupPath, e.message);
    process.exit(1);
  }

  const rows = collectItemsWithImdb(backup);
  const noImdbItems = collectItemsWithoutValidImdb(backup);
  const uniqueIds = [...new Set(rows.map((r) => normImdb(r.m.imdbId)).filter((id) => /^tt\d+$/.test(id)))];
  /** First-seen list row type (movie/show) per IMDb id — disambiguates TMDB find when movie + TV both exist */
  const idToTypeHint = new Map();
  for (const r of rows) {
    const id = normImdb(r.m.imdbId);
    if (!/^tt\d+$/.test(id) || idToTypeHint.has(id)) continue;
    const t = r.m?.type;
    if (t === "show" || t === "movie") idToTypeHint.set(id, t);
  }

  console.log(`Backup: ${backupPath}`);
  console.log(`Rows with imdbId: ${rows.length}, unique IMDb ids: ${uniqueIds.length}`);
  console.log(`Rows without valid imdbId (skipped): ${noImdbItems.length}`);
  console.log(`Watch region (providers): ${watchRegion}`);
  if (dryRun) console.log("DRY RUN — no file write\n");

  const cache = new Map();
  const report = {
    tmdbOk: 0,
    tmdbMiss: 0,
    withTrailer: 0,
    noTmdbTrailer: 0,
    errors: [],
  };

  for (const imdbId of uniqueIds) {
    try {
      const typeHint = idToTypeHint.get(imdbId);
      const e = await enrichFromTmdb(imdbId, tmdbKey, watchRegion, typeHint);
      if (!e) {
        cache.set(imdbId, null);
        report.tmdbMiss++;
      } else {
        const yt = e.youtubeId || null;
        cache.set(imdbId, { ...e, youtubeId: yt });
        report.tmdbOk++;
        if (yt) report.withTrailer++;
        else report.noTmdbTrailer++;
      }
    } catch (err) {
      report.errors.push({ imdbId, err: String(err.message || err) });
      cache.set(imdbId, null);
    }
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  let keyRenames = 0;
  for (const { ref, index, m } of rows) {
    const id = normImdb(m.imdbId);
    if (!/^tt\d+$/.test(id)) continue;
    const e = cache.get(id);
    if (!e) continue;

    const oldKey = movieKey(m);
    const next = { ...m };
    next.title = e.title;
    next.year = e.year;
    next.type = e.type;
    next.genre = e.genre || "";
    if (e.thumb) next.thumb = e.thumb;
    next.youtubeId = e.youtubeId ?? null;
    next.services = Array.isArray(e.services) ? e.services : [];
    next.tmdbId = e.tmdbId;
    next.imdbId = id;

    const newKey = movieKey(next);
    if (oldKey !== newKey) {
      replaceKeyEverywhere(backup, oldKey, newKey);
      keyRenames++;
    }
    ref[index] = next;
  }

  let itemRowsWithTrailer = 0;
  let itemRowsWithNone = 0;
  for (const { ref, index } of rows) {
    const y = ref[index]?.youtubeId;
    if (isPlayableYoutubeTrailerId(y)) itemRowsWithTrailer++;
    else itemRowsWithNone++;
  }

  const tmdbNoMatchRows = [];
  for (const row of rows) {
    const id = normImdb(row.m.imdbId);
    if (!/^tt\d+$/.test(id)) continue;
    if (cache.get(id) != null) continue;
    tmdbNoMatchRows.push(row);
  }

  backup.exportedAt = new Date().toISOString();

  const reportPath = join(rootDir, "backups", "tmdb-backfill-report.txt");
  const mismatchPath = join(rootDir, "backups", "tmdb-backfill-mismatches.txt");
  const lines = [
    `TMDB backfill from IMDb`,
    `Generated: ${backup.exportedAt}`,
    `Source file: ${backupPath}`,
    ``,
    `Unique IMDb ids processed: ${uniqueIds.length}`,
    `TMDB matched: ${report.tmdbOk}, no TMDB match: ${report.tmdbMiss}`,
    `Unique ids with YouTube trailer key from TMDB: ${report.withTrailer}`,
    `Unique ids with no TMDB trailer key (stored as null): ${report.noTmdbTrailer}`,
    `List rows with real youtubeId after backfill: ${itemRowsWithTrailer}`,
    `List rows with null youtubeId: ${itemRowsWithNone}`,
    `movieKey renames (title/year updates): ${keyRenames}`,
    ``,
  ];
  if (report.errors.length) {
    lines.push(`Errors (first 30):`);
    report.errors.slice(0, 30).forEach((x) => lines.push(`  ${x.imdbId}: ${x.err}`));
  }

  const mismatchLines = [
    `TMDB alignment — items that do not match / could not be loaded from TMDB`,
    `Generated: ${backup.exportedAt}`,
    `Backup: ${backupPath}`,
    ``,
    `These are NOT TMDB-backed rows, or TMDB had no entry for the given IMDb id.`,
    ``,
    `=== A. Missing or invalid imdbId (${noImdbItems.length} rows) ===`,
    `Cannot call TMDB /find without a valid tt… id. Data was left unchanged.`,
    ``,
  ];
  for (const x of noImdbItems) {
    mismatchLines.push(
      `  [${x.place}:${x.idLabel}#${x.index}] "${x.title ?? ""}" (${x.year ?? ""}) rawImdb=${JSON.stringify(x.rawImdbId)}`
    );
  }
  mismatchLines.push(
    ``,
    `=== B. Valid imdbId but TMDB returned no movie/TV (${tmdbNoMatchRows.length} rows) ===`,
    `TMDB /find had no result for this IMDb external id — row left unchanged (still non-TMDB data).`,
    ``
  );
  const seenNoMatch = new Set();
  for (const row of tmdbNoMatchRows) {
    const id = normImdb(row.m.imdbId);
    const loc =
      row.place === "user"
        ? `user:${row.userId}`
        : row.place === "shared"
          ? `shared:${row.listId}`
          : "catalog";
    mismatchLines.push(
      `  [${loc}#${row.index}] imdbId=${id} "${row.m.title ?? ""}" (${row.m.year ?? ""})`
    );
    seenNoMatch.add(id);
  }
  mismatchLines.push(``, `Unique IMDb ids with no TMDB match: ${seenNoMatch.size}`, ``);

  mismatchLines.push(`=== C. TMDB API errors (${report.errors.length} ids) ===`, ``);
  if (report.errors.length === 0) {
    mismatchLines.push(`  (none)`);
  } else {
    for (const x of report.errors) {
      mismatchLines.push(`  ${x.imdbId}: ${x.err}`);
    }
  }
  mismatchLines.push(
    ``,
    `Note: Rows in A and B were not overwritten with TMDB data. Fix imdbId or remove bad titles;`,
    `for B, verify the id exists on both IMDb and TMDB (rare for valid tt ids).`
  );

  if (!dryRun) {
    writeFileSync(backupPath, JSON.stringify(backup, null, 2), "utf-8");
    writeFileSync(reportPath, lines.join("\n"), "utf-8");
    writeFileSync(mismatchPath, mismatchLines.join("\n"), "utf-8");
    console.log(`\nWrote ${backupPath}`);
    console.log(`Report: ${reportPath}`);
    console.log(`Mismatches / non-TMDB rows: ${mismatchPath}`);
  } else {
    writeFileSync(mismatchPath, mismatchLines.join("\n"), "utf-8");
    console.log("\n[dry-run] Wrote mismatch report only; backup unchanged.");
    console.log(`Mismatches: ${mismatchPath}`);
  }

  console.log("\n" + lines.join("\n"));

  console.log(
    "\nExample titles that should play inline after backfill (TMDB has YouTube trailers):"
  );
  console.log("  • The Shawshank Redemption — imdb tt0111161");
  console.log("  • Inception — imdb tt1375666");
  console.log("After restore, open the card and Play — youtubeId should be a real key or null.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
