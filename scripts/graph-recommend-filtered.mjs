/**
 * Watchlist — Recommendation Engine v4: Quality-Filtered (O4) + Diversity (O9) + Status Weights (O2)
 *
 * Same as graph-recommend.mjs but with IMDb quality thresholds applied to
 * the top-N candidate pool. Produces side-by-side comparison showing which
 * titles were dropped (low quality) and which were promoted (high quality
 * but previously buried by reference count).
 *
 * O9: --diversity flag applies graph-pruning diversity AFTER quality
 * filtering, showing a three-way comparison: unfiltered → filtered → filtered+diversity.
 *
 * O2: --w-favorite, --w-watched, --w-unliked, --w-unwatched flags control
 * how much each source title contributes to recommendation scores based on
 * the user's relationship to that title.
 *
 * Run:
 *   node scripts/graph-recommend-filtered.mjs <listId> --type show
 *   node scripts/graph-recommend-filtered.mjs <listId> --min-rating 6.0 --min-votes-en 50000
 *   node scripts/graph-recommend-filtered.mjs <listId> --no-filter          # show quality data only
 *   node scripts/graph-recommend-filtered.mjs <listId> --source similar --top 20 --pool 60
 *   node scripts/graph-recommend-filtered.mjs <listId> --allow-unknown      # treat no-IMDb-data as PASS
 *   node scripts/graph-recommend-filtered.mjs <listId> --type show --diversity  # quality + diversity
 *   node scripts/graph-recommend-filtered.mjs <listId> --type show --diversity --w-favorite 2.0 --w-watched 1.0  # with status weights
 *
 * Requires:
 *   - data/tmdb-recs-forward.json (from build-recs-cache.mjs)
 *   - data/imdb/title.ratings.tsv (from https://datasets.imdbws.com/title.ratings.tsv.gz)
 *     then: gunzip title.ratings.tsv.gz && mv title.ratings.tsv data/imdb/
 *   - FIREBASE_SERVICE_ACCOUNT in .env
 *   - TMDB_API_KEY in .env (for imdbId resolution of unknown candidates)
 */

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "../.env") });

const INDEX_PATHS = {
  recs: { forward: resolve(__dirname, "../data/tmdb-recs-forward.json"), inverted: resolve(__dirname, "../data/tmdb-recs-inverted.json") },
  similar: { forward: resolve(__dirname, "../data/tmdb-similar-forward.json"), inverted: resolve(__dirname, "../data/tmdb-similar-inverted.json") },
};

const IMDB_RATINGS_PATH = resolve(__dirname, "../data/imdb/title.ratings.tsv");
const TMDB_CACHE_PATH = resolve(__dirname, "../data/tmdb-cache.json");

const SEP = "═".repeat(67);
let tmdbCacheDirtyCount = 0;

// ─── Firebase ─────────────────────────────────────────────────────────────────

function initFirebase() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT not set in .env");
  const key = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
  const app = initializeApp({ credential: cert(key), projectId: key.project_id });
  return getFirestore(app);
}

// ─── List resolver ────────────────────────────────────────────────────────────

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

// ─── Member UID extraction ────────────────────────────────────────────────────

function extractMemberUids(members) {
  return members.map(m => typeof m === "string" ? m : (m.uid || m.id || null)).filter(Boolean);
}

// ─── IMDb ratings loader ──────────────────────────────────────────────────────

function loadImdbRatings(filePath) {
  const ratings = new Map();
  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  for (let i = 1; i < lines.length; i++) { // skip header
    const parts = lines[i].split("\t");
    if (parts.length >= 3) {
      ratings.set(parts[0], {
        rating: parseFloat(parts[1]),
        votes: parseInt(parts[2], 10),
      });
    }
  }
  return ratings;
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
    tmdbCacheDirtyCount++;
    if (tmdbCacheDirtyCount % 50 === 0) {
      writeFileSync(TMDB_CACHE_PATH, JSON.stringify(cache));
    }
    return data;
  } catch {
    cache[path] = null;
    tmdbCacheDirtyCount++;
    return null;
  }
}

// ─── Quality check ────────────────────────────────────────────────────────────

/**
 * Returns { pass: boolean, reason: string | null }
 * reason is set only when failing.
 */
function qualityCheck(imdbEntry, language, opts) {
  const { minRating, minVotesEn, minVotesForeign, noFilter, allowUnknown } = opts;
  if (noFilter) return { pass: true, reason: null };
  if (!imdbEntry) {
    return allowUnknown
      ? { pass: true, reason: null }
      : { pass: false, reason: "no IMDb data" };
  }
  const { rating, votes } = imdbEntry;
  if (isNaN(rating) || isNaN(votes)) {
    return allowUnknown
      ? { pass: true, reason: null }
      : { pass: false, reason: "invalid IMDb data" };
  }
  if (rating < minRating) {
    return { pass: false, reason: `rating ${rating.toFixed(1)} < ${minRating.toFixed(1)}` };
  }
  const isEnglish = !language || language === "en";
  const minVotes = isEnglish ? minVotesEn : minVotesForeign;
  if (votes < minVotes) {
    const label = isEnglish ? "en" : language;
    return { pass: false, reason: `votes ${votes.toLocaleString()} < ${minVotes.toLocaleString()} (${label})` };
  }
  return { pass: true, reason: null };
}

// ─── Resolve imdbId + language for a candidate ───────────────────────────────

/**
 * Priority:
 *   1. titleRegistry (by tmdbId lookup)
 *   2. TMDB API /movie/{id}?append_to_response=external_ids
 */
async function resolveImdbAndLang(tmdbId, mediaType, tmdbToRegistry, tmdbCache) {
  // 1. Check registry
  const regEntry = tmdbToRegistry.get(String(tmdbId));
  if (regEntry) {
    const d = regEntry.data;
    const imdbId = d.imdbId || null;
    const lang = d.originalLanguage || null;
    if (imdbId) return { imdbId, lang };
    // Has registry entry but no imdbId — still try TMDB for it
  }

  // 2. TMDB API
  const mt = mediaType || "movie";
  const path = `/${mt}/${tmdbId}?append_to_response=external_ids`;
  const data = await fetchTmdb(path, tmdbCache);
  if (!data) return { imdbId: null, lang: null };
  const imdbId = data.external_ids?.imdb_id || null;
  const lang = data.original_language || null;
  return { imdbId, lang };
}

// ─── Diversity ranking (graph pruning) ───────────────────────────────────────

/**
 * Ported from graph-recommend.mjs, extended with weighted scoring.
 *
 * Works on a list of candidate objects (must have .tmdbId, .title, .mediaType,
 * .releaseDate, .references[], .score). Each round:
 *   1. Find rec with highest weighted score (alphabetical tiebreaker)
 *   2. "Use up" all its source imdbIds — remove those refs from all remaining recs
 *   3. Recompute scores; remove zero-score recs from pool
 * Returns top-k selections with metadata about diversity impact.
 */
function runDiversityRanking(candidates, topK) {
  // Deep copy — pool entries track original score separately
  const pool = new Map();
  for (const entry of candidates) {
    const score = entry.references.reduce((sum, r) => sum + (r.weight || 1), 0);
    pool.set(String(entry.tmdbId), {
      tmdbId: String(entry.tmdbId),
      title: entry.title,
      mediaType: entry.mediaType,
      releaseDate: entry.releaseDate,
      // Carry over quality metadata for output
      imdbId: entry.imdbId || null,
      imdbEntry: entry.imdbEntry || null,
      lang: entry.lang || null,
      qualityResult: entry.qualityResult || null,
      references: entry.references.map(r => ({ ...r })),
      count: entry.references.length,
      originalCount: entry.references.length,
      score,
      originalScore: score,
    });
  }

  const selections = [];

  while (selections.length < topK && pool.size > 0) {
    // Find max score in pool
    let maxScore = 0;
    for (const e of pool.values()) {
      if (e.score > maxScore) maxScore = e.score;
    }

    // Collect all candidates tied at max score, sort alphabetically for determinism
    const tied = [...pool.values()]
      .filter(e => Math.abs(e.score - maxScore) < 0.001)
      .sort((a, b) => a.title.localeCompare(b.title));

    const selected = tied[0];
    const wasTiebreak = tied.length > 1;

    // Source imdbIds used by this selection — "spend" these votes
    const usedSourceIds = new Set(selected.references.map(r => r.imdbId));

    let affectedRecs = 0;
    const toDelete = [];

    for (const [tmdbId, entry] of pool) {
      if (tmdbId === selected.tmdbId) continue;
      const before = entry.references.length;
      entry.references = entry.references.filter(r => !usedSourceIds.has(r.imdbId));
      entry.count = entry.references.length;
      entry.score = entry.references.reduce((sum, r) => sum + (r.weight || 1), 0);
      if (entry.count !== before) affectedRecs++;
      if (entry.count === 0) toDelete.push(tmdbId);
    }

    for (const id of toDelete) pool.delete(id);
    pool.delete(selected.tmdbId);

    selections.push({ ...selected, wasTiebreak, tiebreakCount: tied.length, affectedRecs });
  }

  return selections;
}

// ─── Status weight computation ───────────────────────────────────────────────

/**
 * Returns the weight for a reference based on the source title's status and
 * favorite flag. Higher weight = stronger taste signal.
 */
function computeRefWeight(status, isFavorite, opts) {
  if (status === "watched" || status === "archive") {
    return isFavorite ? opts.wFavorite : opts.wWatched;
  }
  // to-watch, maybe-later
  return opts.wUnwatched;
}

// ─── Output helpers ───────────────────────────────────────────────────────────

function fmtMedia(mediaType) {
  if (mediaType === "tv") return "tv";
  if (mediaType === "movie") return "movie";
  return mediaType || "?";
}

function fmtNum(n) {
  if (isNaN(n)) return "—";
  return n.toLocaleString();
}

function truncate(str, maxLen) {
  if (!str) return "";
  return str.length <= maxLen ? str : str.slice(0, maxLen - 1) + "…";
}

// ─── Section: Setup summary ───────────────────────────────────────────────────

function printSetup(opts, listName, listTypeLabel, positiveItems, forwardEntries, imdbCount) {
  const filterStatus = opts.noFilter
    ? "OFF (--no-filter)"
    : `ON (min_rating=${opts.minRating.toFixed(1)}, min_votes_en=${opts.minVotesEn.toLocaleString()}, min_votes_foreign=${opts.minVotesForeign.toLocaleString()})`;

  console.log(`\n🎬 Watchlist Recommendation Engine v4 (Graph-based + Quality Filter${opts.diversity ? " + Diversity" : ""})`);
  console.log(`List: ${listName} (${listTypeLabel})`);
  console.log(`Source: ${opts.source} (${opts.source === "similar" ? "TMDB /similar" : "TMDB /recommendations"})`);
  console.log(`Quality filter: ${filterStatus}`);
  console.log(`Diversity: ${opts.diversity ? "ON (graph pruning)" : "OFF (use --diversity to enable)"}`);
  console.log(`Cross-list exclusion: ${opts.crossList ? "ON" : "OFF (use --cross-list to enable)"}`);
  console.log(`IMDb boost: ${opts.imdbBoost ? `ON (baseline=${opts.imdbBaseline})` : "OFF (use --imdb-boost to enable)"}`);
  if (opts.typeFilter !== "all") console.log(`Type filter: ${opts.typeFilter}`);
  console.log(`Positive signal: ${positiveItems.length} titles (${positiveItems.filter(i => i.status === "watched").length} watched, ${positiveItems.filter(i => i.status === "archive").length} archived)`);
  console.log(`Forward index: ${forwardEntries} entries loaded`);
  console.log(`IMDb ratings: ${imdbCount.toLocaleString()} entries loaded from title.ratings.tsv`);
}

// ─── Section: Candidate quality audit ─────────────────────────────────────────

function printAudit(pool, opts) {
  const isWeighted = opts.wFavorite !== 1.0 || opts.wWatched !== 1.0 || opts.wUnwatched > 0;
  console.log(`\n${SEP}`);
  console.log(` CANDIDATE QUALITY AUDIT (top ${pool.length} by ${isWeighted ? "weighted score" : "reference count"})`);
  console.log(`${SEP}\n`);

  const titleW = 30;
  const scoreCol = isWeighted ? ` ${"Score".padStart(6)}` : "";
  const header =
    ` ${"#".padStart(2)} ${"Title".padEnd(titleW)} ${"Refs".padStart(4)}${scoreCol} ${"IMDb".padStart(5)} ${"Votes".padStart(8)} ${"Lang".padStart(4)} Verdict`;
  console.log(header);
  console.log(" " + "─".repeat(header.length - 1));

  let noDataCount = 0;

  for (let i = 0; i < pool.length; i++) {
    const c = pool[i];
    const rankStr = String(i + 1).padStart(3);
    const titleStr = truncate(c.title, titleW).padEnd(titleW);
    const refsStr = String(c.count).padStart(4);
    const scoreStr = isWeighted ? ` ${c.score.toFixed(1).padStart(6)}` : "";

    if (!c.imdbId || !c.imdbEntry) {
      noDataCount++;
      const verdict = opts.allowUnknown ? "? PASS (unknown, --allow-unknown)" : "✗ FAIL (no IMDb data)";
      console.log(` ${rankStr} ${titleStr} ${refsStr}${scoreStr} ${"—".padStart(5)} ${"—".padStart(8)} ${"?".padStart(4)} ${verdict}`);
      continue;
    }

    const { rating, votes } = c.imdbEntry;
    const ratingStr = isNaN(rating) ? "—" : rating.toFixed(1).padStart(5);
    const votesStr = isNaN(votes) ? "—" : fmtNum(votes).padStart(8);
    const langStr = (c.lang || "?").padStart(4);

    const passStr = c.qualityResult.pass ? "✓ PASS" : "✗ FAIL";
    const reasonStr = c.qualityResult.reason ? ` (${c.qualityResult.reason})` : "";
    const langNote = !c.qualityResult.pass ? "" : c.lang && c.lang !== "en" ? ` (foreign: ${fmtNum(votes)} ≥ ${opts.minVotesForeign.toLocaleString()})` : "";

    console.log(` ${rankStr} ${titleStr} ${refsStr}${scoreStr} ${ratingStr} ${votesStr} ${langStr} ${passStr}${reasonStr}${langNote}`);
  }

  if (noDataCount > 0) {
    console.log(`\n  No IMDb data: ${noDataCount} title${noDataCount !== 1 ? "s" : ""} (TMDB-only, treated as ${opts.allowUnknown ? "PASS" : "FAIL"})`);
  }
  console.log();
}

// ─── Label formatting for comparison columns ─────────────────────────────────

function entryLabel(entry, showScore) {
  if (!entry) return "";
  if (showScore && entry.score !== undefined && entry.score !== entry.count) {
    return `${entry.title} (${entry.score.toFixed(1)})`;
  }
  return `${entry.title} (${entry.count})`;
}

function diversityLabel(entry, showScore) {
  if (!entry) return "";
  const origScore = entry.originalScore !== undefined ? entry.originalScore : entry.originalCount;
  const curScore = showScore ? entry.score : entry.count;
  const origDisplay = showScore ? origScore : entry.originalCount;
  if (origDisplay !== curScore) {
    const origStr = showScore ? origScore.toFixed(1) : String(entry.originalCount);
    const curStr = showScore ? curScore.toFixed(1) : String(curScore);
    return `${entry.title} (${origStr}→${curStr})`;
  }
  const valStr = showScore ? curScore.toFixed(1) : String(curScore);
  return `${entry.title} (${valStr})`;
}

// ─── Section: Side-by-side comparison (2-column, no diversity) ───────────────

function printComparison2Col(unfilteredTop, filteredTop, pool, topK, opts) {
  const isWeighted = opts.wFavorite !== 1.0 || opts.wWatched !== 1.0 || opts.wUnwatched > 0;
  console.log(`${SEP}`);
  console.log(` COMPARISON: UNFILTERED vs QUALITY-FILTERED (top ${topK})`);
  console.log(`${SEP}\n`);

  const unfilteredRankMap = new Map(unfilteredTop.map((c, i) => [c.tmdbId, i + 1]));
  const filteredRankMap = new Map(filteredTop.map((c, i) => [c.tmdbId, i + 1]));

  const colW = 32;
  console.log(`  ${"#".padEnd(4)} ${"Unfiltered".padEnd(colW)} ${"Filtered".padEnd(colW)} Change`);
  console.log("  " + "─".repeat(4 + colW + 1 + colW + 1 + 20));

  const rows = Math.max(unfilteredTop.length, filteredTop.length);
  for (let row = 0; row < rows; row++) {
    const u = unfilteredTop[row];
    const f = filteredTop[row];
    const rankStr = String(row + 1).padStart(3);
    const uLabel = truncate(entryLabel(u, isWeighted), colW - 1).padEnd(colW);

    let fLabel = "";
    let changeStr = "";
    if (f) {
      fLabel = truncate(entryLabel(f, isWeighted), colW - 1).padEnd(colW);
      const unfiltRank = unfilteredRankMap.get(f.tmdbId);
      const filtRank = row + 1;
      if (unfiltRank === undefined) {
        const poolIdx = pool.findIndex(c => c.tmdbId === f.tmdbId);
        changeStr = poolIdx >= 0 ? `↑ from pool #${poolIdx + 1}` : "NEW";
      } else if (unfiltRank === filtRank) {
        changeStr = "—";
      } else if (unfiltRank < filtRank) {
        changeStr = `↓ from #${unfiltRank}`;
      } else {
        changeStr = `↑ from #${unfiltRank}`;
      }
    }
    console.log(`  ${rankStr} ${uLabel} ${fLabel} ${changeStr}`);
  }
  console.log();

  // Dropped / promoted analysis
  const droppedTitles = unfilteredTop.filter(c => !filteredRankMap.has(c.tmdbId));
  if (droppedTitles.length > 0) {
    console.log(`  Dropped by filter (were in unfiltered top-${topK}):`);
    for (const c of droppedTitles) {
      console.log(`    ${c.title} — ${c.qualityResult.reason || "filtered"}`);
    }
    console.log();
  }

  const promotedTitles = filteredTop.filter(c => !unfilteredRankMap.has(c.tmdbId));
  if (promotedTitles.length > 0) {
    console.log(`  Promoted by filter (now in filtered top-${topK}, were NOT in unfiltered top-${topK}):`);
    for (const c of promotedTitles) {
      const poolIdx = pool.findIndex(p => p.tmdbId === c.tmdbId);
      const ratingStr = c.imdbEntry ? `IMDb ${c.imdbEntry.rating.toFixed(1)} / ${fmtNum(c.imdbEntry.votes)} votes` : "no IMDb data";
      const poolPos = poolIdx >= 0 ? ` — was pool #${poolIdx + 1} unfiltered` : "";
      console.log(`    ${c.title} (${c.count} ref${c.count !== 1 ? "s" : ""})${poolPos}, ${ratingStr}`);
    }
    console.log();
  }

  if (droppedTitles.length === 0 && promotedTitles.length === 0) {
    console.log(`  Filter had no effect on top-${topK} — all unfiltered titles passed.\n`);
  }
}

// ─── Section: 3-column comparison (unfiltered, filtered, filtered+diversity) ─

function printComparison3Col(unfilteredTop, filteredTop, diversityTop, pool, topK, opts) {
  const isWeighted = opts.wFavorite !== 1.0 || opts.wWatched !== 1.0 || opts.wUnwatched > 0;
  console.log(`${SEP}`);
  console.log(` COMPARISON: UNFILTERED → FILTERED → FILTERED + DIVERSITY (top ${topK})`);
  console.log(`${SEP}\n`);

  const unfilteredRankMap = new Map(unfilteredTop.map((c, i) => [c.tmdbId, i + 1]));
  const filteredRankMap = new Map(filteredTop.map((c, i) => [c.tmdbId, i + 1]));
  const diversityRankMap = new Map(diversityTop.map((c, i) => [c.tmdbId, i + 1]));

  const colW = 26;
  console.log(`  ${"#".padEnd(4)} ${"Unfiltered".padEnd(colW)} ${"Filtered".padEnd(colW)} ${"Filtered+Diversity".padEnd(colW)} Change`);
  console.log("  " + "─".repeat(4 + colW * 3 + 3 + 20));

  const rows = Math.max(unfilteredTop.length, filteredTop.length, diversityTop.length);
  for (let row = 0; row < rows; row++) {
    const u = unfilteredTop[row];
    const f = filteredTop[row];
    const d = diversityTop[row];
    const rankStr = String(row + 1).padStart(3);

    const uLabel = truncate(entryLabel(u, isWeighted), colW - 1).padEnd(colW);
    const fLabel = truncate(entryLabel(f, isWeighted), colW - 1).padEnd(colW);
    const dLabel = truncate(diversityLabel(d, isWeighted), colW - 1).padEnd(colW);

    // Change column: compare diversity position to filtered position
    let changeStr = "";
    if (d) {
      const filtRank = filteredRankMap.get(d.tmdbId);
      const divRank = row + 1;
      if (filtRank === undefined) {
        changeStr = "↑ diversity boost";
      } else if (filtRank === divRank) {
        changeStr = "—";
      } else if (filtRank < divRank) {
        changeStr = `↓ from filtered #${filtRank}`;
      } else {
        changeStr = `↑ from filtered #${filtRank}`;
      }
    }
    console.log(`  ${rankStr} ${uLabel} ${fLabel} ${dLabel} ${changeStr}`);
  }
  console.log();

  // ── Dropped by quality filter ──
  const droppedByQuality = unfilteredTop.filter(c => !filteredRankMap.has(c.tmdbId));
  if (droppedByQuality.length > 0) {
    console.log(`  Dropped by quality filter (were in unfiltered top-${topK}):`);
    for (const c of droppedByQuality) {
      console.log(`    ${c.title} — ${c.qualityResult.reason || "filtered"}`);
    }
    console.log();
  }

  // ── Reordered by diversity ──
  const reorderedByDiversity = diversityTop.filter(d => {
    const filtRank = filteredRankMap.get(d.tmdbId);
    const divRank = diversityRankMap.get(d.tmdbId);
    return filtRank !== undefined && filtRank !== divRank;
  });
  if (reorderedByDiversity.length > 0) {
    console.log(`  Reordered by diversity (position changed from filtered ranking):`);
    for (const d of reorderedByDiversity) {
      const filtRank = filteredRankMap.get(d.tmdbId);
      const divRank = diversityRankMap.get(d.tmdbId);
      const dir = divRank < filtRank ? "↑" : "↓";
      const countInfo = d.originalCount !== d.count
        ? ` (refs: ${d.originalCount}→${d.count} after pruning)`
        : "";
      console.log(`    ${d.title}: filtered #${filtRank} → diversity #${divRank} ${dir}${countInfo}`);
    }
    console.log();
  }

  // ── Titles unique to diversity top-k (promoted from deeper in filtered pool) ──
  const diversityOnly = diversityTop.filter(d => !filteredRankMap.has(d.tmdbId));
  if (diversityOnly.length > 0) {
    console.log(`  Promoted by diversity (in diversity top-${topK}, NOT in filtered top-${topK}):`);
    for (const d of diversityOnly) {
      const ratingStr = d.imdbEntry ? `IMDb ${d.imdbEntry.rating.toFixed(1)} / ${fmtNum(d.imdbEntry.votes)} votes` : "no IMDb data";
      console.log(`    ${d.title} (${d.originalCount} refs), ${ratingStr}`);
    }
    console.log();
  }

  // ── Titles in filtered top-k but dropped by diversity ──
  const filteredOnly = filteredTop.filter(f => !diversityRankMap.has(f.tmdbId));
  if (filteredOnly.length > 0) {
    console.log(`  In filtered top-${topK} but NOT in diversity top-${topK}:`);
    for (const f of filteredOnly) {
      console.log(`    ${f.title} (${f.count} refs)`);
    }
    console.log();
  }

  if (droppedByQuality.length === 0 && reorderedByDiversity.length === 0 && diversityOnly.length === 0 && filteredOnly.length === 0) {
    console.log(`  No changes across all three rankings.\n`);
  }
}

// ─── Section: Diversity detail ────────────────────────────────────────────────

function printDiversityDetail(diversityTop, topK, opts) {
  const isWeighted = opts.wFavorite !== 1.0 || opts.wWatched !== 1.0 || opts.wUnwatched > 0;
  console.log(`${SEP}`);
  console.log(` DIVERSITY RANKING DETAIL (graph pruning on quality-filtered pool)`);
  console.log(`${SEP}\n`);

  for (let i = 0; i < diversityTop.length; i++) {
    const sel = diversityTop[i];
    const countChanged = sel.count !== sel.originalCount;
    let countStr = countChanged
      ? `${sel.originalCount} references → ${sel.count} after diversity`
      : `${sel.count} reference${sel.count !== 1 ? "s" : ""}`;

    if (isWeighted) {
      const scoreChanged = Math.abs(sel.score - sel.originalScore) > 0.001;
      const scoreInfo = scoreChanged
        ? `, score ${sel.originalScore.toFixed(1)}→${sel.score.toFixed(1)}`
        : `, score ${sel.score.toFixed(1)}`;
      countStr += scoreInfo;
    }

    const ratingStr = sel.imdbEntry ? ` | IMDb ${sel.imdbEntry.rating.toFixed(1)}` : "";

    console.log(`  ${String(i + 1).padStart(2)}. ${sel.title} (${fmtMedia(sel.mediaType)}) — ${countStr}${ratingStr}`);
    console.log(`      Release: ${sel.releaseDate || "unknown"} | TMDB ID: ${sel.tmdbId}`);

    if (sel.wasTiebreak) {
      const tieVal = isWeighted ? `score=${sel.originalScore.toFixed(1)}` : `count=${sel.originalCount}`;
      console.log(`      [tiebreaker: alphabetical among ${sel.tiebreakCount} contenders tied at ${tieVal}]`);
    }

    const refLabel = i > 0 ? "References (surviving after prior diversity rounds):" : "References:";
    console.log(`      ${refLabel}`);
    for (const ref of sel.references) {
      const fav = ref.isFavorite ? ", ★ favorite" : "";
      const weightStr = isWeighted ? `, w=${ref.weight.toFixed(1)}` : "";
      console.log(`        • ${ref.title} (${ref.status}${fav}, position #${ref.position + 1}${weightStr})`);
    }

    const srcCount = sel.references.length;
    console.log(`      [Diversity: removed ${srcCount} source node${srcCount !== 1 ? "s" : ""} → ${sel.affectedRecs} other recs affected]`);
    console.log();
  }
}

// ─── Section: Filter impact summary ──────────────────────────────────────────

function printFilterSummary(pool, unfilteredTop, filteredTop, diversityTop, topK, opts) {
  console.log(`${SEP}`);
  console.log(` FILTER IMPACT SUMMARY`);
  console.log(`${SEP}\n`);

  const passed = pool.filter(c => c.qualityResult.pass).length;
  const failed = pool.length - passed;
  const failLowRating = pool.filter(c => !c.qualityResult.pass && c.qualityResult.reason?.startsWith("rating")).length;
  const failLowVotesEn = pool.filter(c => !c.qualityResult.pass && c.qualityResult.reason?.includes("(en)")).length;
  const failLowVotesForeign = pool.filter(c => !c.qualityResult.pass && c.qualityResult.reason && c.qualityResult.reason.includes("votes") && !c.qualityResult.reason.includes("(en)")).length;
  const failNoData = pool.filter(c => !c.qualityResult.pass && c.qualityResult.reason === "no IMDb data").length;
  const failOther = failed - failLowRating - failLowVotesEn - failLowVotesForeign - failNoData;
  const pct = pool.length > 0 ? Math.round((passed / pool.length) * 100) : 0;

  console.log(`  Pool evaluated: ${pool.length} candidates`);
  console.log(`  Passed filter:  ${passed} (${pct}%)`);
  console.log(`  Failed — low rating:          ${failLowRating}`);
  console.log(`  Failed — low votes (EN):      ${failLowVotesEn}`);
  console.log(`  Failed — low votes (foreign): ${failLowVotesForeign}`);
  console.log(`  Failed — no IMDb data:        ${failNoData}`);
  if (failOther > 0) {
    console.log(`  Failed — other:               ${failOther}`);
  }

  const droppedByQuality = unfilteredTop.filter(c => !filteredTop.find(f => f.tmdbId === c.tmdbId)).length;
  console.log(`\n  Top-${topK} changes from quality filter: ${droppedByQuality} of ${topK} replaced`);

  if (diversityTop) {
    const filteredRankMap = new Map(filteredTop.map((c, i) => [c.tmdbId, i + 1]));
    const diversityRankMap = new Map(diversityTop.map((c, i) => [c.tmdbId, i + 1]));
    const reordered = diversityTop.filter(d => {
      const fRank = filteredRankMap.get(d.tmdbId);
      return fRank === undefined || fRank !== diversityRankMap.get(d.tmdbId);
    }).length;
    console.log(`  Top-${topK} changes from diversity:       ${reordered} of ${topK} moved or swapped`);
  }

  // Average IMDb rating for each ranking
  function avgRating(list) {
    const withData = list.filter(c => c.imdbEntry && !isNaN(c.imdbEntry.rating));
    if (withData.length === 0) return null;
    return withData.reduce((sum, c) => sum + c.imdbEntry.rating, 0) / withData.length;
  }

  const avgUnfiltered = avgRating(unfilteredTop);
  const avgFiltered = avgRating(filteredTop);
  if (avgUnfiltered !== null) {
    console.log(`\n  Avg IMDb rating (unfiltered top-${topK}):            ${avgUnfiltered.toFixed(1)}`);
  }
  if (avgFiltered !== null) {
    console.log(`  Avg IMDb rating (filtered top-${topK}):              ${avgFiltered.toFixed(1)}`);
  }
  if (diversityTop) {
    const avgDiv = avgRating(diversityTop);
    if (avgDiv !== null) {
      console.log(`  Avg IMDb rating (filtered+diversity top-${topK}):    ${avgDiv.toFixed(1)}`);
    }
  }
  console.log();
}

// ─── Cross-list exclusion helpers ────────────────────────────────────────────

function collectWatchedTmdbIds(listData, registry, out) {
  const watched = new Set(listData.watched || []);
  const archive = new Set(listData.archive || []);
  for (const item of listData.items || []) {
    const rid = item.registryId;
    if (!rid) continue;
    if (!watched.has(rid) && !archive.has(rid)) continue;
    const reg = registry[rid];
    if (reg?.tmdbId) out.add(String(reg.tmdbId));
  }
}

async function loadCrossListExcludeTmdbIds(db, targetListId, memberUids, registry) {
  const excludeTmdbIds = new Set();
  const processed = new Set([targetListId]);

  for (const uid of memberUids) {
    const snap = await db.collection("users").doc(uid).collection("personalLists").get();
    for (const doc of snap.docs) {
      if (processed.has(doc.id)) continue;
      processed.add(doc.id);
      collectWatchedTmdbIds(doc.data(), registry, excludeTmdbIds);
    }
  }

  const sharedSnap = await db.collection("sharedLists").get();
  for (const doc of sharedSnap.docs) {
    if (processed.has(doc.id)) continue;
    const docMemberUids = extractMemberUids(doc.data().members || []);
    if (!docMemberUids.some(uid => memberUids.includes(uid))) continue;
    processed.add(doc.id);
    collectWatchedTmdbIds(doc.data(), registry, excludeTmdbIds);
  }

  return excludeTmdbIds;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // ─── Parse CLI ────────────────────────────────────────────────────────────
  const listId = process.argv[2];
  if (!listId || listId.startsWith("--")) {
    console.error("Usage: node scripts/graph-recommend-filtered.mjs <listId> [--uid <uid>] [--type movie|show|all] [--top <k>] [--source recs|similar]");
    console.error("       [--min-rating 6.0] [--min-votes-en 50000] [--min-votes-foreign 3000] [--pool <n>] [--no-filter] [--allow-unknown] [--diversity] [--cross-list]");
    console.error("       [--w-favorite 1.5] [--w-watched 1.0] [--w-unliked 0.3] [--w-unwatched 0.0] [--imdb-boost] [--imdb-baseline 7.0]");
    process.exit(1);
  }

  const argv = process.argv.slice(3);
  function getArg(flag, defaultVal) {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : defaultVal;
  }

  const uid = getArg("--uid", null);
  const typeFilter = getArg("--type", "all");
  const topK = parseInt(getArg("--top", "10"), 10);
  const source = getArg("--source", "recs");
  const minRating = parseFloat(getArg("--min-rating", "6.0"));
  const minVotesEn = parseInt(getArg("--min-votes-en", "50000"), 10);
  const minVotesForeign = parseInt(getArg("--min-votes-foreign", "3000"), 10);
  const noFilter = argv.includes("--no-filter");
  const allowUnknown = argv.includes("--allow-unknown");
  const diversity = argv.includes("--diversity");
  const crossList = argv.includes("--cross-list");
  const imdbBoost = argv.includes("--imdb-boost");
  const imdbBaseline = parseFloat(getArg("--imdb-baseline", "7.0"));
  const wFavorite = parseFloat(getArg("--w-favorite", "1.5"));
  const wWatched = parseFloat(getArg("--w-watched", "1.0"));
  const wUnliked = parseFloat(getArg("--w-unliked", "0.3"));
  const wUnwatched = parseFloat(getArg("--w-unwatched", "0.0")); // 0 = excluded (current behavior)
  const defaultPool = topK * 3;
  const poolSize = parseInt(getArg("--pool", String(defaultPool)), 10);

  if (!["movie", "show", "all"].includes(typeFilter)) {
    console.error(`Invalid --type: "${typeFilter}". Must be movie, show, or all`); process.exit(1);
  }
  if (isNaN(topK) || topK < 1) {
    console.error(`Invalid --top: must be a positive integer`); process.exit(1);
  }
  if (!["recs", "similar"].includes(source)) {
    console.error(`Invalid --source: "${source}". Must be recs or similar`); process.exit(1);
  }
  if (isNaN(poolSize) || poolSize < topK) {
    console.error(`Invalid --pool: must be >= --top (${topK})`); process.exit(1);
  }

  const opts = { typeFilter, topK, source, minRating, minVotesEn, minVotesForeign, noFilter, allowUnknown, diversity, crossList, imdbBoost, imdbBaseline, wFavorite, wWatched, wUnliked, wUnwatched, poolSize };

  const FORWARD_INDEX_PATH = INDEX_PATHS[source].forward;
  const INVERTED_INDEX_PATH = INDEX_PATHS[source].inverted;
  const buildScript = source === "similar" ? "build-similar-cache.mjs" : "build-recs-cache.mjs";

  // ─── Load forward index ──────────────────────────────────────────────────
  for (const [label, path] of [["Forward index", FORWARD_INDEX_PATH], ["Inverted index", INVERTED_INDEX_PATH]]) {
    if (!existsSync(path)) {
      console.error(`${label} not found: ${path}`);
      console.error(`Run: node scripts/${buildScript}`);
      process.exit(1);
    }
  }

  const forwardIndex = JSON.parse(readFileSync(FORWARD_INDEX_PATH, "utf8"));
  const forwardEntries = Object.keys(forwardIndex).length;

  // ─── Load IMDb ratings ───────────────────────────────────────────────────
  if (!existsSync(IMDB_RATINGS_PATH)) {
    console.error(`IMDb ratings file not found: ${IMDB_RATINGS_PATH}`);
    console.error(`Download from: https://datasets.imdbws.com/title.ratings.tsv.gz`);
    console.error(`Then: gunzip title.ratings.tsv.gz && mv title.ratings.tsv data/imdb/`);
    process.exit(1);
  }
  process.stdout.write("Loading IMDb ratings... ");
  const imdbRatings = loadImdbRatings(IMDB_RATINGS_PATH);
  console.log(`${imdbRatings.size.toLocaleString()} entries`);

  // ─── Load TMDB cache ─────────────────────────────────────────────────────
  const tmdbCache = existsSync(TMDB_CACHE_PATH)
    ? JSON.parse(readFileSync(TMDB_CACHE_PATH, "utf8"))
    : {};

  // ─── Init Firebase + load titleRegistry ──────────────────────────────────
  process.stdout.write("Loading Firestore... ");
  const db = initFirebase();
  const regSnap = await db.collection("titleRegistry").get();
  const registry = {};
  const tmdbToRegistry = new Map(); // tmdbId (string) → { id, data }
  for (const doc of regSnap.docs) {
    registry[doc.id] = doc.data();
    const tmdbId = doc.data().tmdbId;
    if (tmdbId) tmdbToRegistry.set(String(tmdbId), { id: doc.id, data: doc.data() });
  }
  console.log(`${regSnap.docs.length} registry docs`);

  // ─── Resolve list ────────────────────────────────────────────────────────
  const list = await resolveList(db, listId, uid);
  const listData = list.data;
  const memberUids = list.type === "shared"
    ? extractMemberUids(list.members)
    : (list.uid ? [list.uid] : []);

  // Load favorites
  const favorites = new Set();
  for (const fuid of memberUids) {
    const userSnap = await db.collection("users").doc(fuid).get();
    if (userSnap.exists) {
      const favMap = userSnap.data().favorites;
      if (favMap && typeof favMap === "object") {
        for (const rid of Object.keys(favMap)) favorites.add(rid);
      }
    }
  }

  // ─── Build list items ────────────────────────────────────────────────────
  const watched = new Set(listData.watched || []);
  const archive = new Set(listData.archive || []);
  const maybeLater = new Set(listData.maybeLater || []);

  const listItems = [];
  for (const item of listData.items || []) {
    const rid = item.registryId;
    if (!rid) continue;
    let status = "to-watch";
    if (watched.has(rid)) status = "watched";
    else if (archive.has(rid)) status = "archive";
    else if (maybeLater.has(rid)) status = "maybe-later";
    const reg = registry[rid] || {};
    listItems.push({
      registryId: rid,
      imdbId: reg.imdbId || null,
      tmdbId: reg.tmdbId ? String(reg.tmdbId) : null,
      title: reg.title || rid,
      status,
      isFavorite: favorites.has(rid),
    });
  }

  // ─── Signal items ───────────────────────────────────────────────────────────
  // Watched/archived always contribute. Unwatched (to-watch/maybe-later) only
  // contribute when their weight is > 0.
  const signalItems = listItems.filter(i => {
    if (i.status === "watched" || i.status === "archive") return true;
    if (opts.wUnwatched > 0 && (i.status === "to-watch" || i.status === "maybe-later")) return true;
    return false;
  });
  // For display purposes, still count the watched/archived subset
  const positiveItems = listItems.filter(i => i.status === "watched" || i.status === "archive");
  const unwatchedSignalItems = signalItems.filter(i => i.status === "to-watch" || i.status === "maybe-later");

  const listTypeLabel = list.type === "shared"
    ? `shared, ${memberUids.length} member${memberUids.length !== 1 ? "s" : ""}`
    : "personal";
  printSetup(opts, list.name, listTypeLabel, positiveItems, forwardEntries, imdbRatings.size);

  if (signalItems.length === 0) {
    console.log("No signal titles on this list. Watch something first!");
    process.exit(0);
  }

  if (unwatchedSignalItems.length > 0) {
    console.log(`  + ${unwatchedSignalItems.length} unwatched titles contributing signal (weight=${opts.wUnwatched})`);
  }

  // Show active weights
  const isWeighted = opts.wFavorite !== 1.0 || opts.wWatched !== 1.0 || opts.wUnwatched > 0;
  if (isWeighted) {
    console.log(`\nStatus weights: favorite=${opts.wFavorite}, watched=${opts.wWatched}, unliked=${opts.wUnliked}, unwatched=${opts.wUnwatched}`);
  }

  // ─── Aggregate recommendations ────────────────────────────────────────────
  const aggregated = {};
  let notInIndex = 0;
  let mappedCount = 0;

  for (const item of signalItems) {
    if (!item.imdbId) { notInIndex++; continue; }
    const entry = forwardIndex[item.imdbId];
    if (!entry) { notInIndex++; continue; }
    mappedCount++;

    const refWeight = computeRefWeight(item.status, item.isFavorite, opts);

    let recs = entry.recs || [];
    if (typeFilter === "movie") recs = recs.filter(r => r.mediaType === "movie");
    else if (typeFilter === "show") recs = recs.filter(r => r.mediaType === "tv");

    for (const rec of recs) {
      const key = String(rec.tmdbId);
      if (!aggregated[key]) {
        aggregated[key] = {
          tmdbId: key,
          title: rec.title,
          mediaType: rec.mediaType,
          releaseDate: rec.releaseDate,
          references: [],
          count: 0,       // raw reference count (unweighted)
          score: 0,        // weighted score
        };
      }
      aggregated[key].references.push({
        imdbId: item.imdbId,
        title: item.title,
        status: item.status,
        isFavorite: item.isFavorite,
        position: rec.position,
        weight: refWeight,
      });
      aggregated[key].count++;
      aggregated[key].score += refWeight;
    }
  }

  if (notInIndex > 0) {
    console.log(`  ${notInIndex} positive title${notInIndex !== 1 ? "s" : ""} not in forward index`);
  }

  // ─── Exclude watched/archived — current list ─────────────────────────────
  const currentExcludeTmdbIds = new Set();
  let noTmdbIdSkipped = 0;
  for (const item of listItems) {
    if (item.status !== "watched" && item.status !== "archive") continue;
    if (!item.tmdbId) { noTmdbIdSkipped++; continue; }
    currentExcludeTmdbIds.add(item.tmdbId);
  }
  let currentExcludeCount = 0;
  for (const tmdbId of currentExcludeTmdbIds) {
    if (tmdbId in aggregated) { delete aggregated[tmdbId]; currentExcludeCount++; }
  }

  // ─── Cross-list exclusion (--cross-list flag) ─────────────────────────────
  let crossListExcludeCount = 0;
  if (opts.crossList) {
    const crossListExcludeTmdbIds = await loadCrossListExcludeTmdbIds(db, listId, memberUids, registry);
    for (const tmdbId of crossListExcludeTmdbIds) {
      if (!currentExcludeTmdbIds.has(tmdbId) && tmdbId in aggregated) {
        delete aggregated[tmdbId];
        crossListExcludeCount++;
      }
    }
  }

  const afterExclusionCount = Object.keys(aggregated).length;
  const dist = { 1: 0, 2: 0, 3: 0, "4+": 0 };
  for (const e of Object.values(aggregated)) {
    if (e.count === 1) dist[1]++;
    else if (e.count === 2) dist[2]++;
    else if (e.count === 3) dist[3]++;
    else dist["4+"]++;
  }

  console.log(`\nRecommendation graph for this list:`);
  console.log(`  ${mappedCount} positive titles mapped to forward index`);
  console.log(`  Excluded from current list: ${currentExcludeCount}`);
  if (opts.crossList) {
    console.log(`  Excluded from cross-list: ${crossListExcludeCount}`);
  }
  console.log(`  After exclusion: ${afterExclusionCount} candidates`);
  console.log(`  Count distribution: 1 ref=${dist[1]}  2 refs=${dist[2]}  3 refs=${dist[3]}  4+=${dist["4+"]}`);

  if (afterExclusionCount === 0) {
    console.log("\nNo recommendation candidates after exclusion.");
    process.exit(0);
  }

  // ─── Build candidate pool (top-N by weighted score) ────────────────────────
  const sortedAll = Object.values(aggregated).sort((a, b) => b.score - a.score || b.count - a.count);
  const poolCandidates = sortedAll.slice(0, poolSize);

  console.log(`\nResolving IMDb data for top-${poolCandidates.length} candidates...`);

  // ─── Resolve imdbId + quality for each pool candidate ────────────────────
  let tmdbApiCallsMade = 0;
  const tmdbCacheCountBefore = Object.keys(tmdbCache).length;

  for (const candidate of poolCandidates) {
    const { imdbId, lang } = await resolveImdbAndLang(
      candidate.tmdbId,
      candidate.mediaType,
      tmdbToRegistry,
      tmdbCache
    );
    candidate.imdbId = imdbId;
    candidate.lang = lang;
    candidate.imdbEntry = imdbId ? (imdbRatings.get(imdbId) || null) : null;
    candidate.qualityResult = qualityCheck(candidate.imdbEntry, lang, opts);
  }

  tmdbApiCallsMade = Object.keys(tmdbCache).length - tmdbCacheCountBefore;
  if (tmdbApiCallsMade > 0) {
    console.log(`  Made ${tmdbApiCallsMade} TMDB API calls`);
  }

  // Save cache
  writeFileSync(TMDB_CACHE_PATH, JSON.stringify(tmdbCache));

  // ─── Apply IMDb rating boost (re-sort pool by boosted score) ──────────────
  if (imdbBoost && imdbRatings) {
    for (const candidate of poolCandidates) {
      candidate.boostedScore = candidate.score; // default: weighted score
      if (candidate.imdbEntry && !isNaN(candidate.imdbEntry.rating)) {
        candidate.boostedScore = candidate.score * (candidate.imdbEntry.rating / imdbBaseline);
      }
    }
    // Re-sort by boosted score
    poolCandidates.sort((a, b) => {
      if (Math.abs(b.boostedScore - a.boostedScore) > 0.001) return b.boostedScore - a.boostedScore;
      // Tiebreaker: recency
      const da = a.releaseDate ? new Date(a.releaseDate).getTime() : 0;
      const db_ = b.releaseDate ? new Date(b.releaseDate).getTime() : 0;
      return db_ - da;
    });
    console.log(`\nIMDb boost applied (baseline=${imdbBaseline})`);
  }

  // ─── Build unfiltered top-k (raw count, no quality) ───────────────────────
  const unfilteredTop = poolCandidates.slice(0, topK);

  // ─── Build filtered top-k (skip FAILs, backfill from pool) ───────────────
  const filteredTop = [];
  for (const candidate of poolCandidates) {
    if (filteredTop.length >= topK) break;
    if (candidate.qualityResult.pass) filteredTop.push(candidate);
  }

  // ─── Build diversity top-k (quality-filtered pool → graph pruning) ────────
  let diversityTop = null;
  if (diversity) {
    // Feed ALL quality-passing candidates from the pool into diversity ranking,
    // not just the top-k — diversity should be able to promote from deeper in
    // the filtered pool when it "spends" source nodes from top candidates.
    const qualityPassingPool = poolCandidates.filter(c => c.qualityResult.pass);
    console.log(`\nRunning diversity ranking on ${qualityPassingPool.length} quality-passing candidates...`);
    diversityTop = runDiversityRanking(qualityPassingPool, topK);
  }

  // ─── Print all sections ───────────────────────────────────────────────────
  printAudit(poolCandidates, opts);

  if (diversity) {
    printComparison3Col(unfilteredTop, filteredTop, diversityTop, poolCandidates, topK, opts);
    printDiversityDetail(diversityTop, topK, opts);
  } else {
    printComparison2Col(unfilteredTop, filteredTop, poolCandidates, topK, opts);
  }

  if (!noFilter) {
    printFilterSummary(poolCandidates, unfilteredTop, filteredTop, diversityTop, topK, opts);
  }

  process.exit(0);
}

main().catch(err => { console.error("\nError:", err.message); process.exit(1); });