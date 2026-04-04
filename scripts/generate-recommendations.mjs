/**
 * Watchlist — Generate Recommendations Pipeline
 *
 * Computes ranked recommendations for every list and writes them to
 * Firestore `recommendations/{listId}` so the React app can display them.
 *
 * Run:
 *   node scripts/generate-recommendations.mjs                        # all lists
 *   node scripts/generate-recommendations.mjs --list <listId>        # one list
 *   node scripts/generate-recommendations.mjs --dry-run              # skip Firestore write
 *   node scripts/generate-recommendations.mjs --source similar       # use /similar index
 *   node scripts/generate-recommendations.mjs --top 5                # top-5 instead of 10
 *
 * Requires:
 *   - FIREBASE_SERVICE_ACCOUNT in .env
 *   - TMDB_API_KEY in .env
 *   - data/tmdb-recs-forward.json (from build-recs-cache.mjs)
 *     OR data/tmdb-similar-forward.json (from build-similar-cache.mjs)
 */

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "../.env") });

const TMDB_CACHE_PATH = resolve(__dirname, "../data/tmdb-cache.json");

const INDEX_PATHS = {
  recs:    resolve(__dirname, "../data/tmdb-recs-forward.json"),
  similar: resolve(__dirname, "../data/tmdb-similar-forward.json"),
};
const IMDB_RATINGS_PATH = resolve(__dirname, "../data/imdb/title.ratings.tsv");

// Config constants are loaded from Firestore at runtime (see main())

// ─── CLI ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const isDryRun  = args.includes("--dry-run");

const listArgIdx   = args.indexOf("--list");
const filterListId = listArgIdx >= 0 ? args[listArgIdx + 1] : null;

const topArgIdx = args.indexOf("--top");
const topK      = topArgIdx >= 0 ? parseInt(args[topArgIdx + 1], 10) : 10;

const sourceArgIdx = args.indexOf("--source");
const source       = sourceArgIdx >= 0 ? args[sourceArgIdx + 1] : "recs";

if (!["recs", "similar"].includes(source)) {
  console.error(`Invalid --source: "${source}". Must be recs or similar`);
  process.exit(1);
}
if (isNaN(topK) || topK < 1) {
  console.error("Invalid --top: must be a positive integer");
  process.exit(1);
}

// ─── Firebase ─────────────────────────────────────────────────────────────────
function initFirebase() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT not set in .env");
  const key = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
  const app = initializeApp({ credential: cert(key), projectId: key.project_id });
  return getFirestore(app);
}

// ─── TMDB fetch with cache ────────────────────────────────────────────────────
async function fetchTmdb(path, cache) {
  if (path in cache) return cache[path];
  await new Promise(r => setTimeout(r, 260));
  try {
    const sep = path.includes("?") ? "&" : "?";
    const url = `https://api.themoviedb.org/3${path}${sep}api_key=${process.env.TMDB_API_KEY}`;
    const res = await fetch(url);
    const data = res.ok ? await res.json() : null;
    cache[path] = data;
    return data;
  } catch {
    cache[path] = null;
    return null;
  }
}

// ─── Trailer key extraction (same logic as add-from-imdb.js) ─────────────────
function pickYoutubeTrailerKey(results) {
  const r = results || [];
  const preferred = (t) => r.find(v => v.site === "YouTube" && v.key && v.type === t);
  const pick =
    preferred("Trailer") ||
    preferred("Teaser") ||
    r.find(v => v.site === "YouTube" && v.key && (v.type === "Clip" || v.type === "Featurette")) ||
    r.find(v => v.site === "YouTube" && v.key);
  return pick ? pick.key : null;
}

// ─── IMDb ratings loader ──────────────────────────────────────────────────────
function loadImdbRatings(path) {
  const ratings = new Map();
  const content = readFileSync(path, "utf8");
  const lines = content.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split("\t");
    if (parts.length >= 3) {
      ratings.set(parts[0], {
        rating: parseFloat(parts[1]),
        votes:  parseInt(parts[2], 10),
      });
    }
  }
  return ratings;
}

// ─── Quality filter ───────────────────────────────────────────────────────────
function passesQualityFilter(enrichedRec, imdbRatings, minRating, minVotesEn, minVotesForeign) {
  if (!imdbRatings) return true; // no ratings file = no filtering

  const imdbId = enrichedRec.imdbId;
  if (!imdbId) return true; // can't filter without imdbId — let it through

  const rating = imdbRatings.get(imdbId);
  if (!rating) return true; // not in IMDb dataset — let it through

  if (rating.rating < minRating) return false;

  const isEnglish = !enrichedRec.originalLanguage || enrichedRec.originalLanguage === "en";
  const minVotes = isEnglish ? minVotesEn : minVotesForeign;

  return rating.votes >= minVotes;
}

// ─── IMDb rating boost ────────────────────────────────────────────────────────
function applyImdbBoost(enrichedPool, imdbRatings, baseline) {
  for (const item of enrichedPool) {
    const { rec, enrich } = item;
    item.boostedScore = rec.count; // default: raw count

    if (!imdbRatings || !enrich.imdbId) continue;
    const rating = imdbRatings.get(enrich.imdbId);
    if (!rating || isNaN(rating.rating)) continue;

    item.boostedScore = rec.count * (rating.rating / baseline);
  }

  // Re-sort by boosted score descending, recency tiebreaker
  enrichedPool.sort((a, b) => {
    if (Math.abs(b.boostedScore - a.boostedScore) > 0.001) return b.boostedScore - a.boostedScore;
    const da = a.rec.releaseDate ? new Date(a.rec.releaseDate).getTime() : 0;
    const db_ = b.rec.releaseDate ? new Date(b.rec.releaseDate).getTime() : 0;
    return db_ - da;
  });
}

// ─── Explanation builder ──────────────────────────────────────────────────────
function buildExplanation(references) {
  if (!references.length) return "Recommended for you";
  const allFavorites = references.every(r => r.isFavorite);
  const verb = allFavorites ? "loved" : "watched";
  const titles = references.map(r => r.title);
  if (titles.length <= 3) {
    return `Because you ${verb}: ${titles.join(", ")}`;
  }
  const shown = titles.slice(0, 3);
  const rest  = titles.length - 3;
  return `Because you ${verb}: ${shown.join(", ")} and ${rest} more`;
}

// ─── Aggregate recommendations for a list ────────────────────────────────────
function aggregateRecs(positiveItems, forwardIndex) {
  const aggregated = {};

  for (const item of positiveItems) {
    if (!item.imdbId) continue;
    const entry = forwardIndex[item.imdbId];
    if (!entry) continue;

    for (const rec of (entry.recs || [])) {
      const key = String(rec.tmdbId);
      if (!aggregated[key]) {
        aggregated[key] = {
          tmdbId:      key,
          title:       rec.title,
          mediaType:   rec.mediaType,
          releaseDate: rec.releaseDate || null,
          references:  [],
          count:       0,
        };
      }
      aggregated[key].references.push({
        title:      item.title,
        isFavorite: item.isFavorite,
        position:   rec.position,
      });
      aggregated[key].count++;
    }
  }

  return aggregated;
}

// ─── Select top-k with tiebreaker ────────────────────────────────────────────
function selectTopK(aggregated, k) {
  const sorted = Object.values(aggregated).sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    // Tiebreaker: most recent releaseDate
    const da = a.releaseDate ? new Date(a.releaseDate).getTime() : 0;
    const db_ = b.releaseDate ? new Date(b.releaseDate).getTime() : 0;
    return db_ - da;
  });
  return sorted.slice(0, k);
}

// ─── Enrich one recommendation ────────────────────────────────────────────────
async function enrichRec(rec, tmdbToRegistry, tmdbCache) {
  const regEntry = tmdbToRegistry.get(rec.tmdbId);

  if (regEntry) {
    const data = regEntry.data;
    return {
      fromRegistry:     true,
      title:            data.title       || rec.title,
      year:             data.year        || null,
      type:             data.type        || (rec.mediaType === "tv" ? "show" : "movie"),
      mediaType:        rec.mediaType,
      genres:           data.genre ? data.genre.split(/[/,|]/).map(g => g.trim()).filter(Boolean) : [],
      thumb:            data.thumb       || null,
      youtubeId:        data.youtubeId   || null,
      imdbId:           data.imdbId      || null,
      originalLanguage: data.originalLanguage || null,
      registryId:       regEntry.id,
      services:         Array.isArray(data.services) ? data.services : [],
    };
  }

  // Fallback: TMDB API
  const mediaType = rec.mediaType || "movie";
  const path = `/${mediaType}/${rec.tmdbId}?append_to_response=videos,external_ids`;
  const data = await fetchTmdb(path, tmdbCache);

  if (!data) {
    return {
      fromRegistry:     false,
      title:            rec.title,
      year:             null,
      type:             mediaType === "tv" ? "show" : "movie",
      mediaType,
      genres:           [],
      thumb:            null,
      youtubeId:        null,
      imdbId:           null,
      originalLanguage: null,
      registryId:       null,
      services:         [],
    };
  }

  const rawYear = data.release_date || data.first_air_date || null;
  const year    = rawYear ? parseInt(rawYear.slice(0, 4), 10) || null : null;
  const thumb   = data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : null;
  const genres  = (data.genres || []).map(g => g.name);
  const youtubeId = pickYoutubeTrailerKey(data.videos?.results);
  const imdbId  = data.external_ids?.imdb_id || data.imdb_id || null;
  const originalLanguage = data.original_language || null;

  return {
    fromRegistry:     false,
    title:            data.title || data.name || rec.title,
    year,
    type:             mediaType === "tv" ? "show" : "movie",
    mediaType,
    genres,
    thumb,
    youtubeId,
    imdbId,
    originalLanguage,
    registryId:       null,
    services:         [],
  };
}

// ─── Build list items with status ────────────────────────────────────────────
function buildListItems(listData, registry, favorites) {
  const watched    = new Set(listData.watched    || []);
  const archive    = new Set(listData.archive    || []);
  const maybeLater = new Set(listData.maybeLater || []);

  const items = [];
  for (const item of listData.items || []) {
    const rid = item.registryId;
    if (!rid) continue;
    let status = "to-watch";
    if (watched.has(rid))         status = "watched";
    else if (archive.has(rid))    status = "archive";
    else if (maybeLater.has(rid)) status = "maybe-later";
    const reg = registry[rid] || {};
    items.push({
      registryId: rid,
      imdbId:     reg.imdbId || null,
      tmdbId:     reg.tmdbId ? String(reg.tmdbId) : null,
      title:      reg.title  || rid,
      status,
      isFavorite: favorites.has(rid),
    });
  }
  return items;
}

// ─── Load favorites for UIDs ──────────────────────────────────────────────────
async function loadFavorites(db, uids) {
  const favorites = new Set();
  for (const uid of uids) {
    const snap = await db.collection("users").doc(uid).get();
    if (snap.exists) {
      const favMap = snap.data().favorites;
      if (favMap && typeof favMap === "object") {
        for (const rid of Object.keys(favMap)) favorites.add(rid);
      }
    }
  }
  return favorites;
}

// ─── Extract member UIDs ──────────────────────────────────────────────────────
function extractMemberUids(members) {
  return (members || []).map(m => typeof m === "string" ? m : (m.uid || m.id || null)).filter(Boolean);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const buildScript = source === "similar" ? "build-similar-cache.mjs" : "build-recs-cache.mjs";
  const forwardIndexPath = INDEX_PATHS[source];

  console.log("🎬  Generating recommendations...");

  // 1. Load forward index
  if (!existsSync(forwardIndexPath)) {
    console.error(`Forward index not found: ${forwardIndexPath}`);
    console.error(`Run: node scripts/${buildScript}`);
    process.exit(1);
  }
  const forwardIndex = JSON.parse(readFileSync(forwardIndexPath, "utf8"));
  console.log(`Loaded ${Object.keys(forwardIndex).length} forward index entries (source: ${source})`);

  // 2. Load tmdb cache
  const tmdbCache = existsSync(TMDB_CACHE_PATH)
    ? JSON.parse(readFileSync(TMDB_CACHE_PATH, "utf8"))
    : {};

  // 2b. Load IMDb ratings for quality filtering
  let imdbRatings = null;
  if (existsSync(IMDB_RATINGS_PATH)) {
    imdbRatings = loadImdbRatings(IMDB_RATINGS_PATH);
    console.log(`IMDb ratings: ${imdbRatings.size.toLocaleString()} entries loaded`);
  } else {
    console.warn(`Warning: IMDb ratings not found at ${IMDB_RATINGS_PATH} — quality filtering disabled`);
  }

  // 3. Init Firebase + load titleRegistry
  const db = initFirebase();
  const regSnap = await db.collection("titleRegistry").get();
  const registry = {};
  // tmdbId (string) → { id: registryId, data: {...} }
  const tmdbToRegistry = new Map();
  for (const doc of regSnap.docs) {
    registry[doc.id] = doc.data();
    const tmdbId = doc.data().tmdbId;
    if (tmdbId) tmdbToRegistry.set(String(tmdbId), { id: doc.id, data: doc.data() });
  }
  console.log(`Loaded ${regSnap.docs.length} titleRegistry docs`);

  // 3b. Load recommendation config from Firestore (admin UI writes here)
  const configDoc = await db.collection("config").doc("recommendations").get();
  const config = configDoc.exists ? configDoc.data() : null;
  const configSource = configDoc.exists ? "Firestore" : "defaults";

  const MIN_RATING        = config?.minRating        ?? 6.0;
  const MIN_VOTES_EN      = config?.minVotesEn       ?? 15000;
  const MIN_VOTES_FOREIGN = config?.minVotesForeign  ?? 3000;
  const POOL_SIZE_CONFIG  = config?.poolSize          ?? 100;
  const IMDB_BOOST        = config?.imdbBoostEnabled  ?? true;
  const IMDB_BASELINE     = config?.imdbBoostBaseline ?? 7.0;
  const ALGORITHM_VERSION = config?.algorithmVersion  ?? "v4-graph-q2";

  console.log(`Config: ${configSource} (version=${ALGORITHM_VERSION}, boost=${IMDB_BOOST ? `on, baseline=${IMDB_BASELINE}` : "off"})`);

  // 4. Load allowedUsers → UIDs
  const allowedSnap = await db.collection("allowedUsers").get();
  const allUids = [];
  for (const doc of allowedSnap.docs) {
    const uid = doc.data().uid;
    if (uid) allUids.push(uid);
  }

  // 5. Collect all lists: personal + shared, deduplicated
  const listsMap = new Map(); // listId → { id, data, type, name, memberUids }

  for (const uid of allUids) {
    const personalSnap = await db.collection("users").doc(uid).collection("personalLists").get();
    for (const doc of personalSnap.docs) {
      if (!listsMap.has(doc.id)) {
        const data = doc.data();
        listsMap.set(doc.id, {
          id: doc.id,
          data,
          type: "personal",
          name: data.name || doc.id,
          memberUids: [uid],
        });
      }
    }
  }

  const sharedSnap = await db.collection("sharedLists").get();
  for (const doc of sharedSnap.docs) {
    if (!listsMap.has(doc.id)) {
      const data = doc.data();
      const memberUids = extractMemberUids(data.members || []);
      listsMap.set(doc.id, {
        id: doc.id,
        data,
        type: "shared",
        name: data.name || doc.id,
        memberUids,
      });
    }
  }

  // 6. Apply --list filter
  let listsToProcess = [...listsMap.values()];
  if (filterListId) {
    listsToProcess = listsToProcess.filter(l => l.id === filterListId);
    if (listsToProcess.length === 0) {
      console.error(`List not found: ${filterListId}`);
      process.exit(1);
    }
  }

  console.log(`\nProcessing ${listsToProcess.length} list${listsToProcess.length !== 1 ? "s" : ""}...`);

  // ─── Stats trackers ────────────────────────────────────────────────────────
  let totalRecsWritten   = 0;
  let totalFromRegistry  = 0;
  let totalFromTmdb      = 0;
  let totalWithTrailer   = 0;
  let totalWithoutTrailer = 0;
  let tmdbApiCalls        = 0;
  let firestoreWrites     = 0;
  const tmdbStartTime     = Date.now();

  // ─── Process each list ─────────────────────────────────────────────────────
  for (const list of listsToProcess) {
    const memberLabel = list.type === "shared"
      ? `shared, ${list.memberUids.length} member${list.memberUids.length !== 1 ? "s" : ""}`
      : `personal, ${list.memberUids[0]?.slice(0, 8) || "?"}`;

    // Load favorites for this list's members
    const favorites = await loadFavorites(db, list.memberUids);

    // Build list items with status
    const listItems = buildListItems(list.data, registry, favorites);

    // Positive signal: watched + archived
    const positiveItems = listItems.filter(i => i.status === "watched" || i.status === "archive");

    if (positiveItems.length === 0) {
      console.log(`  ${list.name} (${memberLabel}): ${listItems.length} items, 0 positive → skipped (no signal)`);
      continue;
    }

    // Aggregate from forward index
    const aggregated = aggregateRecs(positiveItems, forwardIndex);

    // Exclude watched/archived by tmdbId
    for (const item of listItems) {
      if (item.status !== "watched" && item.status !== "archive") continue;
      if (item.tmdbId) delete aggregated[item.tmdbId];
    }

    if (Object.keys(aggregated).length === 0) {
      console.log(`  ${list.name} (${memberLabel}): ${listItems.length} items, ${positiveItems.length} positive → skipped (no candidates after exclusion)`);
      continue;
    }

    // Take pool from config
    const pool = selectTopK(aggregated, POOL_SIZE_CONFIG);

    // Enrich the entire pool
    const tmdbCallsBefore = Object.keys(tmdbCache).length;
    const enrichedPool = [];
    for (const rec of pool) {
      const enrich = await enrichRec(rec, tmdbToRegistry, tmdbCache);
      enrichedPool.push({ rec, enrich });
    }

    // Apply IMDb rating boost (re-sorts pool by boosted score)
    if (IMDB_BOOST && imdbRatings) {
      applyImdbBoost(enrichedPool, imdbRatings, IMDB_BASELINE);
    }

    // Apply quality filter
    const filtered = imdbRatings
      ? enrichedPool.filter(({ enrich }) => passesQualityFilter(enrich, imdbRatings, MIN_RATING, MIN_VOTES_EN, MIN_VOTES_FOREIGN))
      : enrichedPool;

    const dropped = enrichedPool.length - filtered.length;
    if (dropped > 0) {
      console.log(`    Quality filter: ${dropped} of ${enrichedPool.length} dropped, ${filtered.length} passed`);
    }

    // Take top-k from filtered pool (already sorted by ref count from selectTopK)
    const topFiltered = filtered.slice(0, topK);

    // Build enriched items from the filtered top-k
    const enrichedItems = [];
    let listFromRegistry = 0;
    let listFromTmdb = 0;
    let listWithTrailer = 0;
    let listWithoutTrailer = 0;

    for (const { rec, enrich } of topFiltered) {
      const refCount = rec.references.length;
      // Keep only title+isFavorite for the Firestore doc (debug data stays local)
      const references = rec.references.map(r => ({ title: r.title, isFavorite: r.isFavorite }));

      enrichedItems.push({
        tmdbId:      parseInt(rec.tmdbId, 10),
        imdbId:      enrich.imdbId,
        title:       enrich.title,
        year:        enrich.year,
        type:        enrich.type,
        mediaType:   enrich.mediaType,
        genres:      enrich.genres,
        thumb:       enrich.thumb,
        youtubeId:   enrich.youtubeId,
        refCount,
        references,
        explanation: buildExplanation(references),
        registryId:  enrich.registryId,
        services:    enrich.services,
      });

      if (enrich.fromRegistry) {
        listFromRegistry++;
      } else {
        listFromTmdb++;
      }
      if (enrich.youtubeId) listWithTrailer++;
      else listWithoutTrailer++;
    }

    const tmdbCallsAfter = Object.keys(tmdbCache).length;
    tmdbApiCalls += (tmdbCallsAfter - tmdbCallsBefore);
    totalFromRegistry  += listFromRegistry;
    totalFromTmdb      += listFromTmdb;
    totalWithTrailer   += listWithTrailer;
    totalWithoutTrailer += listWithoutTrailer;
    totalRecsWritten   += enrichedItems.length;

    console.log(`  ${list.name} (${memberLabel}): ${listItems.length} items, ${positiveItems.length} positive → ${enrichedItems.length} recs generated`);
    console.log(`    Enriched: ${listFromRegistry} from registry, ${listFromTmdb} from TMDB (${listWithTrailer} with trailer, ${listWithoutTrailer} without)`);

    // Build Firestore document
    const doc = {
      listId:           list.id,
      generatedAt:      new Date().toISOString(),
      source,
      algorithmVersion: ALGORITHM_VERSION,
      qualityFilter:    imdbRatings
        ? { minRating: MIN_RATING, minVotesEn: MIN_VOTES_EN, minVotesForeign: MIN_VOTES_FOREIGN }
        : null,
      imdbBoost:        IMDB_BOOST ? { enabled: true, baseline: IMDB_BASELINE } : null,
      configSource,
      items:            enrichedItems,
    };

    if (isDryRun) {
      console.log(`    [dry-run] Would write recommendations/${list.id}`);
    } else {
      try {
        await db.collection("recommendations").doc(list.id).set(doc);
        firestoreWrites++;
      } catch (err) {
        console.error(`    Error writing recommendations/${list.id}:`, err.message);
      }
    }
  }

  // Save tmdb cache
  writeFileSync(TMDB_CACHE_PATH, JSON.stringify(tmdbCache));

  // Summary
  const elapsed = ((Date.now() - tmdbStartTime) / 1000).toFixed(1);
  console.log(`\nSummary:`);
  console.log(`  ${listsToProcess.length} lists processed`);
  console.log(`  ${totalRecsWritten} total recommendations written`);
  console.log(`  ${totalFromRegistry} enriched from titleRegistry, ${totalFromTmdb} from TMDB`);
  console.log(`  ${totalWithTrailer} with trailers, ${totalWithoutTrailer} without`);
  console.log(`  TMDB API calls: ${tmdbApiCalls} (enrichment) in ${elapsed}s`);
  console.log(`  Quality filter: ${imdbRatings ? "ON" : "OFF (no IMDb data)"}`);
  if (imdbRatings) {
    console.log(`    Thresholds: rating≥${MIN_RATING}, EN votes≥${MIN_VOTES_EN.toLocaleString()}, foreign votes≥${MIN_VOTES_FOREIGN.toLocaleString()}`);
  }
  console.log(`  IMDb boost: ${IMDB_BOOST ? `ON (baseline=${IMDB_BASELINE})` : "OFF"}`);
  if (isDryRun) {
    console.log(`  Firestore writes: 0 (dry run)`);
  } else {
    console.log(`  Firestore writes: ${firestoreWrites} documents`);
  }

  process.exit(0);
}

main().catch(err => { console.error("\nError:", err.message); process.exit(1); });
