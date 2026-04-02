/**
 * Watchlist — Recommendation Engine v4: Build TMDB Graph Cache (Phase 1)
 *
 * Fetches TMDB recommendations for every title in titleRegistry and writes
 * two index files to disk:
 *   data/tmdb-recs-forward.json   — catalog title → its TMDB recs
 *   data/tmdb-recs-inverted.json  — recommended tmdbId → which catalog titles point to it
 *
 * Run:
 *   node scripts/build-recs-cache.mjs                  # full build
 *   node scripts/build-recs-cache.mjs --refresh-days 7 # skip titles updated within 7 days
 *   node scripts/build-recs-cache.mjs --dry-run         # show what would be fetched
 */

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "../.env") });

const FORWARD_INDEX_PATH  = resolve(__dirname, "../data/tmdb-recs-forward.json");
const INVERTED_INDEX_PATH = resolve(__dirname, "../data/tmdb-recs-inverted.json");

const SAVE_INTERVAL = 100; // save forward index every N titles

// ─── CLI ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const refreshDaysIdx = args.indexOf("--refresh-days");
const refreshDays = refreshDaysIdx >= 0 ? parseInt(args[refreshDaysIdx + 1], 10) : null;

// ─── Firebase ────────────────────────────────────────────────────────────────
function initFirebase() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT not set in .env");
  const key = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
  const app = initializeApp({ credential: cert(key), projectId: key.project_id });
  return getFirestore(app);
}

// ─── Media type resolution ───────────────────────────────────────────────────
function resolveTmdbMedia(data) {
  const m = data && data.tmdbMedia;
  if (m === "movie" || m === "tv") return m;
  const t = data && data.type;
  if (t === "movie") return "movie";
  if (t === "show") return "tv";
  return null;
}

// ─── TMDB fetch (no cache — recs data changes, cache would go stale) ─────────
async function fetchTmdb(path) {
  await new Promise(r => setTimeout(r, 260));
  try {
    const sep = path.includes("?") ? "&" : "?";
    const url = `https://api.themoviedb.org/3${path}${sep}api_key=${process.env.TMDB_API_KEY}`;
    const res = await fetch(url);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// ─── Index persistence ───────────────────────────────────────────────────────
function loadForwardIndex() {
  if (!existsSync(FORWARD_INDEX_PATH)) return {};
  try {
    return JSON.parse(readFileSync(FORWARD_INDEX_PATH, "utf8"));
  } catch {
    console.warn("  Warning: forward index file is corrupt — starting fresh");
    return {};
  }
}

function saveForwardIndex(index) {
  writeFileSync(FORWARD_INDEX_PATH, JSON.stringify(index, null, 2));
}

// ─── Build inverted index from forward index ─────────────────────────────────
function buildInvertedIndex(forwardIndex) {
  const inverted = {};

  for (const [imdbId, entry] of Object.entries(forwardIndex)) {
    for (const rec of entry.recs) {
      const key = String(rec.tmdbId);
      if (!inverted[key]) {
        inverted[key] = {
          title: rec.title,
          mediaType: rec.mediaType,
          referencedBy: [],
          count: 0,
          lastUpdated: entry.lastUpdated,
        };
      }
      inverted[key].referencedBy.push({
        imdbId,
        title: entry.title,
        position: rec.position,
        sourceMediaType: entry.mediaType,
      });
      inverted[key].count = inverted[key].referencedBy.length;
      // keep the most recent lastUpdated
      if (entry.lastUpdated > inverted[key].lastUpdated) {
        inverted[key].lastUpdated = entry.lastUpdated;
      }
    }
  }

  return inverted;
}

// ─── Summary stats ───────────────────────────────────────────────────────────
function printCountDistribution(inverted) {
  const dist = { 1: 0, 2: 0, 3: 0, "4+": 0 };
  for (const entry of Object.values(inverted)) {
    const c = entry.count;
    if (c === 1) dist[1]++;
    else if (c === 2) dist[2]++;
    else if (c === 3) dist[3]++;
    else dist["4+"]++;
  }
  console.log("Count distribution:");
  console.log(`  1 reference:  ${String(dist[1]).padStart(5)} titles`);
  console.log(`  2 references: ${String(dist[2]).padStart(5)} titles`);
  console.log(`  3 references: ${String(dist[3]).padStart(5)} titles`);
  console.log(`  4+ references:${String(dist["4+"]).padStart(5)} titles`);
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const startTime = Date.now();

  if (!process.env.TMDB_API_KEY) throw new Error("TMDB_API_KEY not set in .env");

  // 1. Load Firestore titleRegistry
  process.stdout.write("Loading Firestore titleRegistry... ");
  const db = initFirebase();
  const regSnap = await db.collection("titleRegistry").get();
  const allDocs = regSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  console.log(`${allDocs.length} total docs`);

  // 2. Partition docs
  const withTmdbId   = allDocs.filter(d => d.tmdbId && resolveTmdbMedia(d) !== null);
  const noTmdbId     = allDocs.filter(d => !d.tmdbId);
  const noMediaType  = allDocs.filter(d => d.tmdbId && resolveTmdbMedia(d) === null);

  console.log(`  ${withTmdbId.length} with tmdbId + resolvable media type`);
  console.log(`  ${noTmdbId.length} without tmdbId (skipped)`);
  if (noMediaType.length > 0) {
    console.log(`  ${noMediaType.length} with tmdbId but unresolvable media type (skipped):`);
    for (const d of noMediaType) console.log(`    ${d.imdbId || d.id} — tmdbMedia=${d.tmdbMedia} type=${d.type}`);
  }
  console.log();

  // 3. Load existing forward index (for incremental / resume)
  const forwardIndex = loadForwardIndex();
  const existingCount = Object.keys(forwardIndex).length;
  if (existingCount > 0) console.log(`  Loaded ${existingCount} existing entries from forward index`);

  // 4. Determine what to fetch
  const now = new Date();
  const toFetch = [];
  let skipCached = 0;

  for (const doc of withTmdbId) {
    const imdbId = doc.imdbId;
    if (!imdbId) continue; // need imdbId as forward index key

    const existing = forwardIndex[imdbId];
    if (existing && refreshDays !== null) {
      const age = (now - new Date(existing.lastUpdated)) / (1000 * 60 * 60 * 24);
      if (age < refreshDays) { skipCached++; continue; }
    } else if (existing && refreshDays === null) {
      // Full build: re-fetch everything (don't skip unless --refresh-days given)
    }

    toFetch.push(doc);
  }

  console.log(`Titles to fetch: ${toFetch.length}`);
  if (skipCached > 0) console.log(`  Skipping ${skipCached} cached (within ${refreshDays} days)`);
  console.log();

  if (isDryRun) {
    console.log("Dry run — no API calls made.");
    for (const doc of toFetch.slice(0, 20)) {
      const media = resolveTmdbMedia(doc);
      console.log(`  Would fetch: ${doc.imdbId} — ${doc.title} [${media}/${doc.tmdbId}]`);
    }
    if (toFetch.length > 20) console.log(`  ... and ${toFetch.length - 20} more`);
    return;
  }

  // 5. Fetch TMDB recommendations for each title
  let fetched = 0;
  let errors = 0;
  let zeroRecs = 0;
  let totalRecs = 0;

  for (let i = 0; i < toFetch.length; i++) {
    const doc = toFetch[i];
    const imdbId = doc.imdbId;
    const mediaType = resolveTmdbMedia(doc);
    const tmdbId = doc.tmdbId;
    const sourceTitle = doc.title || imdbId;

    const path = `/${mediaType}/${tmdbId}/recommendations`;
    const data = await fetchTmdb(path);

    const lastUpdated = new Date().toISOString();

    if (!data) {
      console.warn(`  Warning: TMDB returned null for ${imdbId} (${sourceTitle}) — storing empty recs`);
      errors++;
      forwardIndex[imdbId] = {
        tmdbId,
        title: sourceTitle,
        mediaType,
        recs: [],
        totalResults: 0,
        totalPages: 0,
        lastUpdated,
      };
    } else {
      const results = data.results || [];
      const recs = results.map((r, idx) => ({
        tmdbId: r.id,
        title: r.title || r.name || "",
        mediaType: r.media_type || mediaType,
        position: idx,
        releaseDate: r.release_date || r.first_air_date || null,
      }));

      if (recs.length === 0) zeroRecs++;
      totalRecs += recs.length;

      forwardIndex[imdbId] = {
        tmdbId,
        title: sourceTitle,
        mediaType,
        recs,
        totalResults: data.total_results ?? results.length,
        totalPages: data.total_pages ?? 1,
        lastUpdated,
      };
    }

    fetched++;

    // Progress every 50 titles
    if ((i + 1) % 50 === 0) {
      console.log(`  ... ${i + 1}/${toFetch.length} fetched (${skipCached} cached, ${noTmdbId.length} no-tmdbId, ${errors} errors)`);
    }

    // Periodic save every SAVE_INTERVAL titles
    if (fetched % SAVE_INTERVAL === 0) {
      saveForwardIndex(forwardIndex);
    }
  }

  // 6. Final forward index save
  saveForwardIndex(forwardIndex);
  const totalEntries = Object.keys(forwardIndex).length;
  const avgRecs = totalEntries > 0 ? (totalRecs / (fetched || 1)).toFixed(1) : 0;
  console.log(`\nForward index complete:`);
  console.log(`  ${fetched} fetched this run, ${skipCached} skipped (cached)`);
  console.log(`  ${totalEntries} total entries in index`);
  console.log(`  ${totalRecs} recs gathered this run, avg ${avgRecs} per title`);
  if (zeroRecs > 0) console.log(`  ${zeroRecs} titles returned 0 recs from TMDB (possible bad tmdbId or obscure title)`);
  if (errors > 0) console.log(`  ${errors} titles had TMDB errors (stored with empty recs)`);
  console.log();

  // 7. Build inverted index
  process.stdout.write("Building inverted index... ");
  const invertedIndex = buildInvertedIndex(forwardIndex);
  const uniqueRecs = Object.keys(invertedIndex).length;
  console.log(`${uniqueRecs} unique recommended titles\n`);

  // 8. Save inverted index
  writeFileSync(INVERTED_INDEX_PATH, JSON.stringify(invertedIndex, null, 2));

  // 9. Summary stats
  printCountDistribution(invertedIndex);
  console.log();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Done. ${fetched} API calls in ${elapsed}s`);
  console.log(`  Forward index:  ${FORWARD_INDEX_PATH}`);
  console.log(`  Inverted index: ${INVERTED_INDEX_PATH}`);
}

main().catch(err => { console.error("\nError:", err.message); process.exit(1); });
