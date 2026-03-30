/**
 * Watchlist — Content-Based Recommendation Engine v2
 *
 * Run: node scripts/recommendations.mjs <firebase-uid>
 * Requires:
 *   - FIREBASE_SERVICE_ACCOUNT in .env
 *   - data/imdb/title.basics.tsv
 *   - data/imdb/title.ratings.tsv
 *   - data/imdb-watched.csv (optional — IMDb export for extra history signal)
 *
 * Changes from v1:
 *   - MIN_VOTES raised 5k → 50k (filters out niche/regional titles)
 *   - Genre dimensions weighted 3× (fixes score compression)
 *   - IMDb watched CSV import for richer history signal
 */

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createReadStream, existsSync, readFileSync } from "fs";
import { createInterface } from "readline";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "../.env") });

const IMDB_BASICS       = resolve(__dirname, "../data/imdb/title.basics.tsv");
const IMDB_RATINGS      = resolve(__dirname, "../data/imdb/title.ratings.tsv");
const IMDB_WATCHED_CSV  = resolve(__dirname, "../data/imdb-watched.csv");

const MIN_VOTES  = 50000;  // raised from 5k — filters regional/niche titles
const MIN_YEAR   = 1970;
const VALID_TYPES = new Set(["movie", "tvSeries", "tvMiniSeries", "tvMovie"]);
const TOP_N      = 20;

// ─── Feature weights ──────────────────────────────────────────────────────────
// Genre dimensions are weighted 3× to prevent year/rating from dominating.
// Without this, everything clusters near 93-94% because year and lang:en
// are nearly identical across all candidates.
const GENRE_WEIGHT    = 3.0;
const LANGUAGE_WEIGHT = 1.0;
const TYPE_WEIGHT     = 1.0;
const YEAR_WEIGHT     = 1.0;
const RATING_WEIGHT   = 1.5;  // slightly upweight — prefer higher rated titles

// ─── Firebase ─────────────────────────────────────────────────────────────────

function initFirebase() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT not set in .env");
  const key = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
  const app = initializeApp({ credential: cert(key), projectId: key.project_id });
  return getFirestore(app);
}

// ─── TSV reader ───────────────────────────────────────────────────────────────

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

// ─── Feature vocabulary ───────────────────────────────────────────────────────

const GENRES = [
  "action","adventure","animation","biography","comedy","crime",
  "documentary","drama","family","fantasy","history","horror",
  "music","musical","mystery","romance","sci-fi","sport",
  "thriller","war","western",
];
const LANGUAGES = ["en","he","fr","es","de","ko","ja","it","ar"];

// Vector layout:
// [0..G-1]         genres × GENRE_WEIGHT
// [G..G+L-1]       languages × LANGUAGE_WEIGHT
// [G+L]            type (movie=1) × TYPE_WEIGHT
// [G+L+1]          year normalized × YEAR_WEIGHT
// [G+L+2]          rating normalized × RATING_WEIGHT
const G = GENRES.length;    // 21
const L = LANGUAGES.length; // 9
const DIM = G + L + 3;      // 33

function buildVector(genreList, language, isMovie, year, rating) {
  const v = new Array(DIM).fill(0);

  // Genres (weighted)
  for (const g of genreList) {
    const idx = GENRES.indexOf(g.toLowerCase().trim());
    if (idx >= 0) v[idx] = GENRE_WEIGHT;
  }

  // Language (weighted)
  const langIdx = LANGUAGES.indexOf((language || "en").toLowerCase());
  v[G + (langIdx >= 0 ? langIdx : 0)] = LANGUAGE_WEIGHT;

  // Type
  v[G + L]     = (isMovie ? 1 : 0) * TYPE_WEIGHT;
  // Year: [1970,2030] → [0,1]
  v[G + L + 1] = Math.max(0, Math.min(1, ((year || 2000) - 1970) / 60)) * YEAR_WEIGHT;
  // Rating: [1,10] → [0,1]
  v[G + L + 2] = Math.max(0, Math.min(1, ((rating || 5) - 1) / 9)) * RATING_WEIGHT;

  return v;
}

// ─── Math ─────────────────────────────────────────────────────────────────────

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

function featureName(i) {
  if (i < G) return `genre:${GENRES[i]}`;
  const j = i - G;
  if (j < L) return `lang:${LANGUAGES[j]}`;
  return ["type:movie", "year", "rating"][j - L];
}

function explain(candidateVec, watchedTitles) {
  return watchedTitles
    .map(t => ({ title: t.title, isFavorite: t.isFavorite ?? false, score: cosine(candidateVec, t.vector) }))
    .filter(t => t.score > 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

// ─── IMDb watched CSV parser ──────────────────────────────────────────────────
// IMDb export format: Const,Your Rating,Date Rated,Title,URL,Title Type,IMDb Rating,Runtime (mins),Year,Genres,Num Votes,Release Date,Directors
// We only need: Const (imdbId), Title Type, Title, Year, Genres

function loadImdbWatchedCsv(filePath) {
  if (!existsSync(filePath)) return [];
  const lines = readFileSync(filePath, "utf8").split("\n");
  if (lines.length < 2) return [];

  const header = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));
  const idxConst     = header.indexOf("Const");
  const idxTitle     = header.indexOf("Title");
  const idxYear      = header.indexOf("Year");
  const idxGenres    = header.indexOf("Genres");
  const idxTitleType = header.indexOf("Title Type");
  const idxRating    = header.indexOf("IMDb Rating");

  if (idxConst < 0) return [];

  const results = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    // Simple CSV parse (handles quoted fields)
    const fields = line.match(/(".*?"|[^,]+|(?<=,)(?=,)|(?<=,)$|^(?=,))/g) || line.split(",");
    const clean = (s) => (s || "").replace(/^"|"$/g, "").trim();

    const imdbId    = clean(fields[idxConst]);
    const titleType = clean(fields[idxTitleType]);
    const title     = clean(fields[idxTitle]);
    const year      = parseInt(clean(fields[idxYear]));
    const genres    = clean(fields[idxGenres]).split(",").map(g => g.trim());
    const rating    = parseFloat(clean(fields[idxRating])) || 7;

    if (!imdbId || !imdbId.startsWith("tt")) continue;

    const validTypes = new Set(["Movie", "TV Series", "TV Mini Series", "TV Movie", "TV Episode"]);
    if (!validTypes.has(titleType)) continue;

    results.push({
      imdbId,
      title,
      year: isNaN(year) ? 2000 : year,
      type: titleType === "Movie" || titleType === "TV Movie" ? "movie" : "show",
      genres,
      rating,
      source: "imdb-csv",
    });
  }
  return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const uid = process.argv[2];
  if (!uid) { console.error("Usage: node scripts/recommendations.mjs <uid>"); process.exit(1); }

  console.log("\n🎬  Watchlist Recommendation Engine v2\n");

  // 1. IMDb ratings
  process.stdout.write("Loading IMDb ratings... ");
  const ratings = new Map();
  await readTsv(IMDB_RATINGS, ([tconst, avgRating, numVotes]) => {
    if (parseInt(numVotes) >= MIN_VOTES)
      ratings.set(tconst, { rating: parseFloat(avgRating), votes: parseInt(numVotes) });
  });
  console.log(`${ratings.size.toLocaleString()} titles with ≥${MIN_VOTES.toLocaleString()} votes`);

  // 2. IMDb basics → candidates
  process.stdout.write("Building candidate pool... ");
  const candidates = new Map();
  await readTsv(IMDB_BASICS, ([tconst, titleType, primaryTitle, , , startYear, , , genres]) => {
    if (!VALID_TYPES.has(titleType)) return;
    const r = ratings.get(tconst);
    if (!r) return;
    const year = parseInt(startYear);
    if (isNaN(year) || year < MIN_YEAR) return;
    if (!genres || genres === "\\N") return;
    candidates.set(tconst, {
      imdbId: tconst,
      title: primaryTitle,
      year,
      type: (titleType === "movie" || titleType === "tvMovie") ? "movie" : "show",
      genres: genres.split(","),
      rating: r.rating,
      votes: r.votes,
      language: "en",
    });
  });
  console.log(`${candidates.size.toLocaleString()} quality candidates`);

  // 3. Firestore
  process.stdout.write("Loading Firestore... ");
  const db = initFirebase();
  const regSnap = await db.collection("titleRegistry").get();
  const registry = {};
  for (const doc of regSnap.docs) {
    const data = doc.data();
    registry[doc.id] = data;
    if (data.imdbId && candidates.has(data.imdbId) && data.originalLanguage)
      candidates.get(data.imdbId).language = data.originalLanguage;
  }

  // User lists
  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) { console.error(`\nUser not found: ${uid}`); process.exit(1); }

  const statusPriority = { archive: 3, watched: 2, "to-watch": 1, "maybe-later": 0 };
  const deduped = {};

  const plSnap = await userRef.collection("personalLists").get();
  for (const plDoc of plSnap.docs) {
    const pl = plDoc.data();
    const watched    = new Set(pl.watched    || []);
    const archive    = new Set(pl.archive    || []);
    const maybeLater = new Set(pl.maybeLater || []);
    for (const item of pl.items || []) {
      const rid = item.registryId; if (!rid) continue;
      let status = "to-watch";
      if (watched.has(rid)) status = "watched";
      else if (archive.has(rid)) status = "archive";
      else if (maybeLater.has(rid)) status = "maybe-later";
      const reg = registry[rid] || {};
      const ex = deduped[rid];
      if (!ex || statusPriority[status] > statusPriority[ex.status])
        deduped[rid] = { registryId: rid, imdbId: reg.imdbId, title: reg.title, status };
    }
  }

  const sharedSnap = await db.collection("sharedLists").where("members","array-contains",uid).get();
  for (const sharedDoc of sharedSnap.docs) {
    const sl = sharedDoc.data();
    const watched = new Set(sl.watched || []);
    const archive = new Set(sl.archive || []);
    for (const item of sl.items || []) {
      const rid = item.registryId; if (!rid) continue;
      let status = "to-watch";
      if (watched.has(rid)) status = "watched";
      else if (archive.has(rid)) status = "archive";
      const reg = registry[rid] || {};
      const ex = deduped[rid];
      if (!ex || statusPriority[status] > statusPriority[ex.status])
        deduped[rid] = { registryId: rid, imdbId: reg.imdbId, title: reg.title, status };
    }
  }

  // Favorites
  const userDocData = userSnap.data();
  const favMap = (userDocData.favorites && typeof userDocData.favorites === "object") ? userDocData.favorites : {};
  const favorites = new Set(Object.keys(favMap));

  const userItems = Object.values(deduped);

  // All IMDb IDs the user already has (to exclude from candidates)
  const userImdbIds = new Set([
    ...userItems.map(i => i.imdbId).filter(Boolean),
    ...Object.values(registry).map(r => r.imdbId).filter(Boolean),
  ]);

  console.log(
    `${userItems.length} Firestore titles — ` +
    `${userItems.filter(i=>i.status==="watched").length} watched, ` +
    `${userItems.filter(i=>i.status==="archive").length} archived, ` +
    `${userItems.filter(i=>i.status==="to-watch").length} to watch`
  );

  // 4. IMDb watched CSV (optional extra history signal)
  const imdbWatched = loadImdbWatchedCsv(IMDB_WATCHED_CSV);
  if (imdbWatched.length > 0) {
    console.log(`  + ${imdbWatched.length} titles from IMDb watched CSV`);
    // Add their imdbIds to exclusion set
    for (const t of imdbWatched) userImdbIds.add(t.imdbId);
  }
  console.log();

  // 5. Build positive signal
  // Firestore watched + archived + IMDb CSV watched
  const positiveTitles = [];

  for (const item of userItems.filter(i => i.status === "watched" || i.status === "archive")) {
    let meta = item.imdbId && candidates.has(item.imdbId) ? candidates.get(item.imdbId) : null;
    if (!meta) {
      const reg = registry[item.registryId] || {};
      if (!reg.genre) continue;
      meta = { title: reg.title, year: reg.year, type: reg.type,
               genres: reg.genre.split(/[/,|]/), rating: 7, language: reg.originalLanguage || "en" };
    }
    positiveTitles.push({
      title: meta.title || item.title,
      status: item.status,
      isFavorite: favorites.has(item.registryId),
      vector: buildVector(meta.genres, meta.language, meta.type === "movie", meta.year, meta.rating),
    });
  }

  for (const item of imdbWatched) {
    positiveTitles.push({
      title: item.title,
      status: "watched",
      vector: buildVector(item.genres, "en", item.type === "movie", item.year, item.rating),
    });
  }

  if (positiveTitles.length === 0) {
    console.log("No watched/archived titles. Watch something first!");
    process.exit(0);
  }

  console.log(`Positive signal: ${positiveTitles.length} titles total\n`);

  // 6. Taste profile (weighted average)
  const tasteProfile = weightedAvg(
    positiveTitles.map(t => t.vector),
    positiveTitles.map(t => {
      if (t.status === "archive" && t.isFavorite) return 3;
      if (t.status === "archive") return 2;
      if (t.status === "watched" && t.isFavorite) return 2;
      return 1;
    })
  );

  console.log("Your taste profile (top features):");
  tasteProfile
    .map((val, i) => ({ label: featureName(i), val }))
    .sort((a, b) => b.val - a.val)
    .slice(0, 12)
    .filter(({ val }) => val >= 0.05)
    .forEach(({ label, val }) => {
      const bar = "█".repeat(Math.round(val / (GENRE_WEIGHT) * 20));
      console.log(`  ${label.padEnd(22)} ${bar} ${(val).toFixed(2)}`);
    });
  console.log();

  // 7. Score candidates
  process.stdout.write("Scoring candidates... ");
  const scored = [];
  for (const [imdbId, cand] of candidates) {
    if (userImdbIds.has(imdbId)) continue;
    const vector = buildVector(cand.genres, cand.language, cand.type === "movie", cand.year, cand.rating);
    scored.push({ cand, vector, score: cosine(tasteProfile, vector) });
  }
  scored.sort((a, b) => b.score - a.score);
  console.log(`${scored.length.toLocaleString()} candidates scored\n`);

  // 8. Top-N
  console.log("═".repeat(65));
  console.log(`  TOP ${TOP_N} RECOMMENDATIONS`);
  console.log("═".repeat(65) + "\n");

  for (let i = 0; i < Math.min(TOP_N, scored.length); i++) {
    const { cand, vector, score } = scored[i];
    const expl = explain(vector, positiveTitles);
    const explPrefix = expl.length && expl.every(e => e.isFavorite) ? "Because you loved:" : "Because you liked:";
    const explStr = expl.length ? `${explPrefix} ${expl.map(e=>e.title).join(", ")}` : "Matches your taste profile";
    const typeLabel = cand.type === "movie" ? "MOVIE" : "SERIES";
    console.log(`${(i+1).toString().padStart(2)}. ${cand.title} (${cand.year}) [${typeLabel}]`);
    console.log(`    Match: ${(score*100).toFixed(1)}%  |  IMDb: ${cand.rating}/10  |  ${cand.votes.toLocaleString()} votes`);
    console.log(`    Genres: ${cand.genres.join(", ")}`);
    console.log(`    ${explStr}`);
    console.log(`    https://www.imdb.com/title/${cand.imdbId}/`);
    console.log();
  }

  // 9. Distribution
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

  process.exit(0);
}

main().catch(err => { console.error("\nError:", err.message); process.exit(1); });
