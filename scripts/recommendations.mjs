/**
 * Watchlist — Content-Based Recommendation Engine v3
 *
 * Run: node scripts/recommendations.mjs <listId> [--uid <uid>] [--type movie|show|all]
 * Requires:
 *   - FIREBASE_SERVICE_ACCOUNT in .env
 *   - TMDB_API_KEY in .env
 *   - data/imdb/title.basics.tsv
 *   - data/imdb/title.ratings.tsv
 *   - data/tmdb-cache.json (auto-created — gitignored)
 *
 * v3 philosophy: v1's simplicity + v2's infrastructure.
 *   - Simple cosine similarity on genre+enrichment vectors (no IDF, no MMR, no hybrid blend)
 *   - Per-list positive signal, cross-list exclusion
 *   - Full TMDB enrichment for all candidates
 *   - Feature-aware explanations
 *   - High MIN_VOTES (50k) to surface mainstream quality titles
 */

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createReadStream, existsSync, readFileSync, writeFileSync } from "fs";
import { createInterface } from "readline";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "../.env") });

const IMDB_BASICS       = resolve(__dirname, "../data/imdb/title.basics.tsv");
const IMDB_RATINGS      = resolve(__dirname, "../data/imdb/title.ratings.tsv");
const TMDB_CACHE_PATH   = resolve(__dirname, "../data/tmdb-cache.json");

// ─── Thresholds ──────────────────────────────────────────────────────────────
const MIN_VOTES         = 50000;
const MIN_VOTES_FOREIGN = 3000;
const MIN_RATING = 6.0;
const MIN_YEAR   = 1970;
const VALID_TYPES = new Set(["movie", "tvSeries", "tvMiniSeries", "tvMovie"]);
const TOP_N      = 20;

// ─── Feature weights ────────────────────────────────────────────────────────
const GENRE_WEIGHT    = 3.0;
const KEYWORD_WEIGHT  = 2.0;
const DIRECTOR_WEIGHT = 3.0;
const ACTOR_WEIGHT    = 1.5;

// ─── Feature vocabulary ─────────────────────────────────────────────────────
const GENRES = [
  "action","adventure","animation","biography","comedy","crime",
  "documentary","drama","family","fantasy","history","horror",
  "music","musical","mystery","romance","sci-fi","sport",
  "thriller","war","western",
];
const G = GENRES.length; // 21

// CLI flags
const typeArgIdx = process.argv.indexOf("--type");
const TYPE_FILTER = typeArgIdx >= 0 ? process.argv[typeArgIdx + 1] : "all";

// Enriched vocabulary — populated after TMDB enrichment
let KEYWORDS  = [];
let DIRECTORS = [];
let ACTORS    = [];

// ─── Firebase ───────────────────────────────────────────────────────────────
function initFirebase() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT not set in .env");
  const key = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
  const app = initializeApp({ credential: cert(key), projectId: key.project_id });
  return getFirestore(app);
}

// ─── TSV reader ─────────────────────────────────────────────────────────────
function readTsv(filePath, onRow) {
  return new Promise((resolve, reject) => {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    let header = null;
    rl.on("line", (line) => {
      if (!header) { header = line.split("\t"); return; }
      onRow(line.split("\t"), header);
    });
    rl.on("close", resolve);
    rl.on("error", reject);
  });
}

// ─── TMDB cache ─────────────────────────────────────────────────────────────
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

// ─── Vector building ────────────────────────────────────────────────────────
function buildVector(genreList, keywords, directors, actors) {
  const KW = KEYWORDS.length;
  const DR = DIRECTORS.length;
  const AC = ACTORS.length;
  const v = new Array(G + KW + DR + AC).fill(0);

  for (const g of genreList) {
    const idx = GENRES.indexOf(g.toLowerCase().trim());
    if (idx >= 0) v[idx] = GENRE_WEIGHT;
  }
  for (const kw of (keywords || [])) {
    const idx = KEYWORDS.indexOf(kw);
    if (idx >= 0) v[G + idx] = KEYWORD_WEIGHT;
  }
  for (const dir of (directors || [])) {
    const idx = DIRECTORS.indexOf(dir);
    if (idx >= 0) v[G + KW + idx] = DIRECTOR_WEIGHT;
  }
  for (const actor of (actors || [])) {
    const idx = ACTORS.indexOf(actor);
    if (idx >= 0) v[G + KW + DR + idx] = ACTOR_WEIGHT;
  }
  return v;
}

function featureName(i) {
  if (i < G) return `genre:${GENRES[i]}`;
  const k = i - G;
  if (k < KEYWORDS.length) return `kw:${KEYWORDS[k]}`;
  const d = k - KEYWORDS.length;
  if (d < DIRECTORS.length) return `dir:${DIRECTORS[d]}`;
  return `actor:${ACTORS[d - DIRECTORS.length]}`;
}

// ─── Math ───────────────────────────────────────────────────────────────────
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const mag = (v) => Math.sqrt(dot(v, v));
const cosine = (a, b) => { const ma = mag(a), mb = mag(b); return (ma && mb) ? dot(a, b) / (ma * mb) : 0; };

function weightedAvg(vectors, weights) {
  const dim = vectors[0].length;
  const avg = new Array(dim).fill(0);
  const total = weights.reduce((s, w) => s + w, 0);
  for (let i = 0; i < vectors.length; i++)
    for (let j = 0; j < dim; j++) avg[j] += vectors[i][j] * weights[i];
  return avg.map(v => v / total);
}

// ─── Explanation ────────────────────────────────────────────────────────────
function explain(candidateVector, watchedTitles, enrichData, candidateImdbId) {
  const candEnrich = enrichData.get(candidateImdbId) || {};

  return watchedTitles
    .map(t => {
      const watchEnrich = enrichData.get(t.imdbId) || {};
      const sharedKw = (candEnrich.keywords || []).filter(k => (watchEnrich.keywords || []).includes(k));
      const sharedDir = (candEnrich.directors || []).filter(d => (watchEnrich.directors || []).includes(d));
      const sharedAct = (candEnrich.cast || []).filter(a => (watchEnrich.cast || []).includes(a));
      return {
        title: t.title,
        isFavorite: t.isFavorite,
        score: cosine(candidateVector, t.vector),
        sharedKw, sharedDir, sharedAct,
      };
    })
    .filter(t => t.score > 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

function formatExplanation(matches) {
  if (!matches.length) return "Matches your taste profile";

  const prefix = matches.every(t => t.isFavorite) ? "Because you loved:" : "Because you liked:";
  const titleStr = matches.map(e => e.title).join(", ");

  const allDir = [...new Set(matches.flatMap(t => t.sharedDir))];
  const allAct = [...new Set(matches.flatMap(t => t.sharedAct))];
  const allKw = [...new Set(matches.flatMap(t => t.sharedKw))];

  const parts = [];
  if (allDir.length > 0) parts.push(`director ${allDir.slice(0, 2).join(", ")}`);
  if (allAct.length > 0) parts.push(allAct.slice(0, 2).join(", "));
  if (allKw.length > 0) parts.push(allKw.slice(0, 3).join(", "));

  if (parts.length > 0) return `${prefix} ${titleStr} (shared: ${parts.join("; ")})`;
  return `${prefix} ${titleStr}`;
}

// ─── Franchise dedup ────────────────────────────────────────────────────────
function dedupeByCollection(titles) {
  const groups = {};
  const noCollection = [];
  for (const t of titles) {
    if (t.collectionId) {
      if (!groups[t.collectionId]) groups[t.collectionId] = [];
      groups[t.collectionId].push(t);
    } else {
      noCollection.push(t);
    }
  }
  const deduped = [...noCollection];
  for (const group of Object.values(groups)) {
    const maxWeight = Math.max(...group.map(t => t._weight || 2));
    const avgVec = weightedAvg(group.map(t => t.vector), group.map(() => 1));
    deduped.push({
      title: group.map(t => t.title).join(" / "),
      status: group[0].status,
      isFavorite: group.some(t => t.isFavorite),
      vector: avgVec,
      _weight: maxWeight,
      collectionId: group[0].collectionId,
    });
  }
  return deduped;
}

// ─── List resolver ──────────────────────────────────────────────────────────
async function resolveList(db, listId, uid) {
  const sharedDoc = await db.collection("sharedLists").doc(listId).get();
  if (sharedDoc.exists) {
    const data = sharedDoc.data();
    return { data, type: "shared", name: data.name || listId, members: data.members || [] };
  }
  if (uid) {
    const personalDoc = await db.collection("users").doc(uid).collection("personalLists").doc(listId).get();
    if (personalDoc.exists) {
      const data = personalDoc.data();
      return { data, type: "personal", name: data.name || listId, uid };
    }
    console.error(`List not found: ${listId} (tried sharedLists and users/${uid}/personalLists)`);
  } else {
    console.error(`List not found in sharedLists: ${listId}. For personal lists, use --uid <uid>`);
  }
  process.exit(1);
}

// ─── Cross-list exclusion ───────────────────────────────────────────────────
function extractMemberUids(members) {
  return members.map(m => typeof m === "string" ? m : (m.uid || m.id || null)).filter(Boolean);
}

async function collectSeenImdbIds(db, registry, uids) {
  const seen = new Set();
  const listsSummary = [];
  const uidSet = new Set(uids);

  for (const uid of uids) {
    const personalSnap = await db.collection("users").doc(uid).collection("personalLists").get();
    for (const doc of personalSnap.docs) {
      const data = doc.data();
      const watched = new Set(data.watched || []);
      const archive = new Set(data.archive || []);
      let count = 0;
      for (const item of data.items || []) {
        const rid = item.registryId; if (!rid) continue;
        if (watched.has(rid) || archive.has(rid)) {
          const reg = registry[rid] || {};
          if (reg.imdbId) { seen.add(reg.imdbId); count++; }
        }
      }
      if (count > 0) listsSummary.push({ uid: uid.slice(0, 8), list: data.name || doc.id, type: "personal", seen: count });
    }
  }

  const sharedSnap = await db.collection("sharedLists").get();
  for (const doc of sharedSnap.docs) {
    const data = doc.data();
    const memberUids = extractMemberUids(data.members || []);
    if (!memberUids.some(m => uidSet.has(m))) continue;
    const watched = new Set(data.watched || []);
    const archive = new Set(data.archive || []);
    let count = 0;
    for (const item of data.items || []) {
      const rid = item.registryId; if (!rid) continue;
      if (watched.has(rid) || archive.has(rid)) {
        const reg = registry[rid] || {};
        if (reg.imdbId) { seen.add(reg.imdbId); count++; }
      }
    }
    if (count > 0) listsSummary.push({ list: data.name || doc.id, type: "shared", seen: count });
  }

  return { seen, listsSummary };
}

async function buildExclusionSet(db, registry, list, uid) {
  const uids = list.type === "personal" ? [uid] : extractMemberUids(list.members);
  const label = list.type === "personal" ? `user ${uid.slice(0, 8)}` : `${uids.length} members`;
  console.log(`  Building exclusion set for ${label}...`);
  const { seen, listsSummary } = await collectSeenImdbIds(db, registry, uids);
  console.log(`  Exclusion: ${seen.size} titles seen across ${listsSummary.length} lists`);
  for (const s of listsSummary) {
    const owner = s.uid ? ` (${s.uid}…)` : "";
    console.log(`    ${s.type.padEnd(9)} "${s.list}"${owner}: ${s.seen} seen`);
  }
  return seen;
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const listId = process.argv[2];
  if (!listId) {
    console.error("Usage: node scripts/recommendations.mjs <listId> [--uid <uid>] [--type movie|show|all]");
    process.exit(1);
  }
  const uidArgIdx = process.argv.indexOf("--uid");
  const uid = uidArgIdx >= 0 ? process.argv[uidArgIdx + 1] : null;

  const tmdbCache = existsSync(TMDB_CACHE_PATH)
    ? JSON.parse(readFileSync(TMDB_CACHE_PATH, "utf8"))
    : {};

  // 1. IMDb ratings
  process.stdout.write("Loading IMDb ratings... ");
  const ratings = new Map();
  await readTsv(IMDB_RATINGS, ([tconst, avgRating, numVotes]) => {
    if (parseInt(numVotes) >= MIN_VOTES_FOREIGN)
      ratings.set(tconst, { rating: parseFloat(avgRating), votes: parseInt(numVotes) });
  });
  console.log(`${ratings.size.toLocaleString()} titles with ≥${MIN_VOTES_FOREIGN.toLocaleString()} votes (staging)`);

  // 2. IMDb basics → candidates
  process.stdout.write("Building candidate pool... ");
  const candidates = new Map();
  await readTsv(IMDB_BASICS, ([tconst, titleType, primaryTitle, , , startYear, , , genres]) => {
    if (!VALID_TYPES.has(titleType)) return;
    const r = ratings.get(tconst);
    if (!r) return;
    if (r.rating < MIN_RATING) return;
    const year = parseInt(startYear);
    if (isNaN(year) || year < MIN_YEAR) return;
    if (!genres || genres === "\\N") return;
    const candType = (titleType === "movie" || titleType === "tvMovie") ? "movie" : "show";
    if (TYPE_FILTER !== "all" && candType !== TYPE_FILTER) return;
    candidates.set(tconst, {
      imdbId: tconst, title: primaryTitle, year, type: candType,
      genres: genres.split(","), rating: r.rating, votes: r.votes, language: "en",
    });
  });
  console.log(`${candidates.size.toLocaleString()} quality candidates`);

  // 3. Firestore
  process.stdout.write("Loading Firestore... ");
  const db = initFirebase();
  const regSnap = await db.collection("titleRegistry").get();
  const registry = {};
  const imdbToTmdb = new Map();
  for (const doc of regSnap.docs) {
    const data = doc.data();
    registry[doc.id] = data;
    if (data.imdbId && candidates.has(data.imdbId) && data.originalLanguage)
      candidates.get(data.imdbId).language = data.originalLanguage;
    if (data.imdbId && data.tmdbId) imdbToTmdb.set(data.imdbId, data.tmdbId);
  }

  const upcomingSnap = await db.collection("upcomingChecks").get();
  const tmdbToCollection = new Map();
  for (const doc of upcomingSnap.docs) {
    const data = doc.data();
    const tmdbId = doc.id.split("_")[0];
    const collId = data.collectionId ?? data.belongs_to_collection ?? null;
    if (collId !== null) tmdbToCollection.set(tmdbId, collId);
  }

  // 4. Resolve target list
  const list = await resolveList(db, listId, uid);
  const listData = list.data;
  const listTypeLabel = list.type === "shared"
    ? `shared, ${list.members.length} members`
    : "personal";

  console.log("\n🎬  Watchlist Recommendation Engine v3");
  console.log(`List: ${list.name} (${listTypeLabel})\n`);

  // Load favorites from all relevant users
  let favorites = new Set();
  const favUids = list.type === "personal" ? [list.uid] : extractMemberUids(list.members);
  for (const fuid of favUids) {
    if (!fuid) continue;
    const userSnap = await db.collection("users").doc(fuid).get();
    if (userSnap.exists) {
      const favMap = (userSnap.data().favorites && typeof userSnap.data().favorites === "object")
        ? userSnap.data().favorites : {};
      for (const rid of Object.keys(favMap)) favorites.add(rid);
    }
  }

  // Build list items with status
  const watched    = new Set(listData.watched    || []);
  const archive    = new Set(listData.archive    || []);
  const maybeLater = new Set(listData.maybeLater || []);

  const listItems = [];
  for (const item of listData.items || []) {
    const rid = item.registryId; if (!rid) continue;
    let status = "to-watch";
    if (watched.has(rid)) status = "watched";
    else if (archive.has(rid)) status = "archive";
    else if (maybeLater.has(rid)) status = "maybe-later";
    const reg = registry[rid] || {};
    listItems.push({ registryId: rid, imdbId: reg.imdbId, title: reg.title, status });
  }

  // Cross-list exclusion
  const excludeImdbIds = new Set(listItems.map(i => i.imdbId).filter(Boolean));
  const crossListSeen = await buildExclusionSet(db, registry, list, uid);
  for (const id of crossListSeen) excludeImdbIds.add(id);
  console.log(`  Total exclusion: ${excludeImdbIds.size} unique IMDb IDs\n`);

  console.log(
    `${listItems.length} titles on list — ` +
    `${listItems.filter(i=>i.status==="watched").length} watched, ` +
    `${listItems.filter(i=>i.status==="archive").length} archived, ` +
    `${listItems.filter(i=>i.status==="to-watch").length} to watch\n`
  );

  // 5. Positive signal from this list
  const positiveItems = listItems.filter(i => i.status === "watched" || i.status === "archive");
  const positiveTitles = [];
  for (const item of positiveItems) {
    let meta = item.imdbId && candidates.has(item.imdbId) ? candidates.get(item.imdbId) : null;
    if (!meta) {
      const reg = registry[item.registryId] || {};
      if (!reg.genre) continue;
      meta = { title: reg.title, year: reg.year, type: reg.type,
               genres: reg.genre.split(/[/,|]/), rating: 7, language: reg.originalLanguage || "en" };
    }
    const tmdbId = imdbToTmdb.get(item.imdbId);
    const collectionId = tmdbToCollection.get(String(tmdbId)) ?? null;
    positiveTitles.push({
      title: meta.title || item.title,
      status: item.status,
      isFavorite: favorites.has(item.registryId),
      imdbId: item.imdbId,
      collectionId,
      _genres: meta.genres,
      _type: meta.type,
      _language: meta.language,
    });
  }

  if (positiveTitles.length === 0) {
    console.log("No watched/archived titles. Watch something first!");
    process.exit(0);
  }
  console.log(`Positive signal: ${positiveTitles.length} titles total`);

  // Language-aware vote filter
  const positiveLanguages = new Set(positiveTitles.map(t => t._language).filter(Boolean));
  positiveLanguages.add("en");
  for (const [imdbId, cand] of [...candidates]) {
    if (!positiveLanguages.has(cand.language)) { candidates.delete(imdbId); continue; }
    if (cand.votes < (cand.language !== "en" ? MIN_VOTES_FOREIGN : MIN_VOTES)) candidates.delete(imdbId);
  }
  console.log(`  ${candidates.size.toLocaleString()} candidates after vote filter`);

  // Franchise dedup count
  const franchiseGroups = new Set(positiveTitles.filter(t => t.collectionId).map(t => t.collectionId)).size;
  console.log(`  Collapsed ${franchiseGroups} franchise groups\n`);

  // 6. TMDB enrichment — ALL candidates + positive titles
  const toEnrichSet = new Set();
  const toEnrich = [];
  for (const pt of positiveTitles) {
    const tmdbId = imdbToTmdb.get(pt.imdbId);
    if (tmdbId && !toEnrichSet.has(pt.imdbId)) {
      toEnrichSet.add(pt.imdbId);
      toEnrich.push({ imdbId: pt.imdbId, tmdbId, isMovie: pt._type === "movie" });
    }
  }
  for (const [imdbId, cand] of candidates) {
    if (excludeImdbIds.has(imdbId) || toEnrichSet.has(imdbId)) continue;
    if (TYPE_FILTER !== "all" && cand.type !== TYPE_FILTER) continue;
    toEnrichSet.add(imdbId);
    toEnrich.push({ imdbId, tmdbId: imdbToTmdb.get(imdbId) || null, isMovie: cand.type === "movie" });
  }

  console.log(`Enriching ${toEnrich.length} titles from TMDB...`);
  const enrichData = new Map();
  let fetchedCount = 0, cacheCount = 0, findCount = 0, findMissCount = 0;
  for (let i = 0; i < toEnrich.length; i++) {
    let { imdbId, tmdbId, isMovie } = toEnrich[i];

    if (!tmdbId) {
      const findPath = `/find/${imdbId}?external_source=imdb_id`;
      const findData = await fetchTmdb(findPath, tmdbCache);
      const results = isMovie ? (findData?.movie_results || []) : (findData?.tv_results || []);
      if (results.length > 0) {
        tmdbId = results[0].id;
        imdbToTmdb.set(imdbId, tmdbId);
        findCount++;
      } else {
        findMissCount++;
        continue;
      }
    }

    const kwPath   = isMovie ? `/movie/${tmdbId}/keywords` : `/tv/${tmdbId}/keywords`;
    const credPath = isMovie ? `/movie/${tmdbId}/credits`  : `/tv/${tmdbId}/aggregate_credits`;
    const bothCached = kwPath in tmdbCache && credPath in tmdbCache;

    const kwData   = await fetchTmdb(kwPath, tmdbCache);
    const credData = await fetchTmdb(credPath, tmdbCache);

    if (bothCached) cacheCount++; else fetchedCount++;
    if ((i + 1) % 200 === 0) {
      console.log(`  ... ${i + 1}/${toEnrich.length} (${fetchedCount} fetched, ${cacheCount} cached, ${findCount} found, ${findMissCount} miss)`);
      writeFileSync(TMDB_CACHE_PATH, JSON.stringify(tmdbCache));
    }

    const keywords = (kwData?.keywords || kwData?.results || []).map(k => k.name.toLowerCase());
    const directors = (credData?.crew || [])
      .filter(c => isMovie ? c.job === "Director" : (c.jobs || []).some(j => j.job === "Director"))
      .map(c => c.name);
    const cast = (credData?.cast || [])
      .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
      .slice(0, 5)
      .map(c => c.name);

    enrichData.set(imdbId, { keywords, directors, cast });
  }
  console.log(`  Enrichment complete: ${fetchedCount} fetched, ${cacheCount} cached, ${findCount} found, ${findMissCount} miss`);

  // 7. Build vocabulary from enriched data
  const kwFreq = {}, dirFreq = {}, actFreq = {};
  for (const { keywords, directors, cast } of enrichData.values()) {
    for (const kw  of keywords)  kwFreq[kw]   = (kwFreq[kw]   || 0) + 1;
    for (const dir of directors) dirFreq[dir] = (dirFreq[dir] || 0) + 1;
    for (const act of cast)      actFreq[act] = (actFreq[act] || 0) + 1;
  }
  KEYWORDS  = Object.entries(kwFreq).sort((a, b) => b[1] - a[1]).slice(0, 100).map(([k]) => k);
  DIRECTORS = Object.entries(dirFreq).sort((a, b) => b[1] - a[1]).slice(0, 150).map(([k]) => k);
  ACTORS    = Object.entries(actFreq).sort((a, b) => b[1] - a[1]).slice(0, 300).map(([k]) => k);
  const totalDim = G + KEYWORDS.length + DIRECTORS.length + ACTORS.length;
  console.log(`  Vocabulary: ${KEYWORDS.length} kw, ${DIRECTORS.length} dir, ${ACTORS.length} actors → ${totalDim} dims\n`);

  // 8. Build vectors for positive titles
  for (const pt of positiveTitles) {
    const enrich = enrichData.get(pt.imdbId) || {};
    pt.vector = buildVector(pt._genres, enrich.keywords, enrich.directors, enrich.cast);
  }

  // 9. Taste profile
  const dedupedTitles = dedupeByCollection(positiveTitles);
  const tasteProfile = weightedAvg(
    dedupedTitles.map(t => t.vector),
    dedupedTitles.map(t => {
      if (t._weight) return t._weight;
      if ((t.status === "archive" || t.status === "watched") && t.isFavorite) return 4;
      if (t.status === "archive") return 2;
      if (t.status === "watched") return 1.5;
      return 1;
    })
  );

  console.log("Your taste profile (top features):");
  tasteProfile
    .map((val, i) => ({ label: featureName(i), val }))
    .sort((a, b) => b.val - a.val)
    .slice(0, 15)
    .filter(({ val }) => val >= 0.05)
    .forEach(({ label, val }) => {
      const bar = "█".repeat(Math.round(val / GENRE_WEIGHT * 20));
      console.log(`  ${label.padEnd(26)} ${bar} ${val.toFixed(2)}`);
    });
  console.log();

  // 10. Score all candidates
  process.stdout.write("Scoring candidates... ");
  const scored = [];
  for (const [imdbId, cand] of candidates) {
    if (excludeImdbIds.has(imdbId)) continue;
    if (TYPE_FILTER !== "all" && cand.type !== TYPE_FILTER) continue;
    const enrich = enrichData.get(imdbId) || {};
    const vector = buildVector(cand.genres, enrich.keywords, enrich.directors, enrich.cast);
    scored.push({ cand, vector, score: cosine(tasteProfile, vector) });
  }
  scored.sort((a, b) => b.score - a.score);
  console.log(`${scored.length.toLocaleString()} candidates scored\n`);

  // 11. Top-N output
  const modeLabel = TYPE_FILTER === "movie" ? "MOVIE " : TYPE_FILTER === "show" ? "SHOW " : "";
  console.log("═".repeat(65));
  console.log(`  TOP ${TOP_N} ${modeLabel}RECOMMENDATIONS`);
  console.log("═".repeat(65) + "\n");

  for (let i = 0; i < Math.min(TOP_N, scored.length); i++) {
    const { cand, vector, score } = scored[i];
    const expl = explain(vector, positiveTitles, enrichData, cand.imdbId);
    const explStr = formatExplanation(expl);
    const typeLabel = cand.type === "movie" ? "MOVIE" : "SERIES";
    console.log(`${(i+1).toString().padStart(2)}. ${cand.title} (${cand.year}) [${typeLabel}]`);
    console.log(`    Match: ${(score*100).toFixed(1)}%  |  IMDb: ${cand.rating}/10  |  ${cand.votes.toLocaleString()} votes`);
    console.log(`    Genres: ${cand.genres.join(", ")}`);
    console.log(`    ${explStr}`);
    console.log(`    https://www.imdb.com/title/${cand.imdbId}/`);
    console.log();
  }

  // 12. Language distribution
  const langDist = {};
  for (const r of scored.slice(0, TOP_N))
    langDist[r.cand.language || "?"] = (langDist[r.cand.language || "?"] || 0) + 1;
  console.log("Language distribution:");
  for (const [lang, count] of Object.entries(langDist).sort((a, b) => b[1] - a[1]))
    console.log(`  ${lang.padEnd(4)} ${count}`);
  console.log();

  // 13. Score distribution
  console.log("═".repeat(65));
  console.log("  SCORE DISTRIBUTION");
  console.log("═".repeat(65) + "\n");
  [
    ["90-100% (excellent)", 0.9, 1.1],
    ["70-90%  (strong)",    0.7, 0.9],
    ["50-70%  (good)",      0.5, 0.7],
    ["30-50%  (decent)",    0.3, 0.5],
    ["0-30%   (weak)",      0.0, 0.3],
  ].forEach(([label, min, max]) => {
    const count = scored.filter(s => s.score >= min && s.score < max).length;
    console.log(`  ${label}: ${count.toLocaleString().padStart(6)} titles`);
  });

  writeFileSync(TMDB_CACHE_PATH, JSON.stringify(tmdbCache));
  process.exit(0);
}

main().catch(err => { console.error("\nError:", err.message); process.exit(1); });
