/**
 * Watchlist — Recommendation Engine v4: Graph-based (Phase 2)
 *
 * Run: node scripts/graph-recommend.mjs <listId> [--uid <uid>] [--type movie|show|all] [--top <k>] [--source recs|similar]
 * Requires:
 *   - FIREBASE_SERVICE_ACCOUNT in .env
 *   - data/tmdb-recs-forward.json    (from build-recs-cache.mjs)   — default
 *   - data/tmdb-similar-forward.json (from build-similar-cache.mjs) — with --source similar
 *
 * Phase 1 built two JSON indices from TMDB. This script loads those indices,
 * aggregates recs for a specific list, and outputs two ranked lists:
 *   Ranking A — raw count (no diversity, ties shown as groups)
 *   Ranking B — diversity-adjusted via graph pruning
 */

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "../.env") });

const INDEX_PATHS = {
  recs:    { forward: resolve(__dirname, "../data/tmdb-recs-forward.json"),    inverted: resolve(__dirname, "../data/tmdb-recs-inverted.json") },
  similar: { forward: resolve(__dirname, "../data/tmdb-similar-forward.json"), inverted: resolve(__dirname, "../data/tmdb-similar-inverted.json") },
};
const SEP = "═".repeat(67);

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

// ─── Diversity ranking (graph pruning) ───────────────────────────────────────
/**
 * Works on a deep copy of aggregated. Each round:
 *   1. Find rec with highest count (alphabetical tiebreaker)
 *   2. "Use up" all its source imdbIds — remove those refs from all remaining recs
 *   3. Recompute counts; remove zero-count recs from pool
 * Returns top-k selections with metadata about diversity impact.
 */
function runDiversityRanking(aggregated, topK) {
  // Deep copy — pool entries track original count separately
  const pool = new Map();
  for (const [tmdbId, entry] of Object.entries(aggregated)) {
    pool.set(String(tmdbId), {
      tmdbId: String(tmdbId),
      title: entry.title,
      mediaType: entry.mediaType,
      releaseDate: entry.releaseDate,
      references: entry.references.map(r => ({ ...r })),
      count: entry.references.length,
      originalCount: entry.references.length,
    });
  }

  const selections = [];

  while (selections.length < topK && pool.size > 0) {
    // Find max count in pool
    let maxCount = 0;
    for (const e of pool.values()) {
      if (e.count > maxCount) maxCount = e.count;
    }

    // Collect all candidates tied at max, sort alphabetically for determinism
    const tied = [...pool.values()]
      .filter(e => e.count === maxCount)
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
      if (entry.count !== before) affectedRecs++;
      if (entry.count === 0) toDelete.push(tmdbId);
    }

    for (const id of toDelete) pool.delete(id);
    pool.delete(selected.tmdbId);

    selections.push({ ...selected, wasTiebreak, tiebreakCount: tied.length, affectedRecs });
  }

  return selections;
}

// ─── Output helpers ───────────────────────────────────────────────────────────
function fmtMedia(mediaType) {
  if (mediaType === "tv") return "tv";
  if (mediaType === "movie") return "movie";
  return mediaType || "?";
}

function barChart(count, max, width = 48) {
  const len = Math.max(1, Math.round((count / max) * width));
  return "█".repeat(len);
}

function printRankingA(aggregated, topK) {
  console.log(`\n${SEP}`);
  console.log("  RANKING A: RAW (by reference count, no diversity)");
  console.log(`${SEP}\n`);

  const sorted = Object.values(aggregated).sort((a, b) => b.count - a.count);

  let rankStart = 1;
  let i = 0;

  while (i < sorted.length) {
    if (rankStart > topK) break;

    const currentCount = sorted[i].count;
    let j = i;
    while (j < sorted.length && sorted[j].count === currentCount) j++;
    const group = sorted.slice(i, j);

    if (group.length === 1) {
      const e = group[0];
      const refs = e.references.length;
      console.log(` ${String(rankStart).padStart(2)}. ${e.title} (${fmtMedia(e.mediaType)}) — ${refs} reference${refs !== 1 ? "s" : ""}`);
      console.log(`     Release: ${e.releaseDate || "unknown"}  |  TMDB ID: ${e.tmdbId}`);
      console.log(`     References:`);
      for (const ref of e.references) {
        const fav = ref.isFavorite ? ", ★ favorite" : "";
        console.log(`       • ${ref.title} (${ref.status}${fav}, position #${ref.position + 1})`);
      }
      console.log();
      rankStart++;
    } else {
      // Tie group — compact display with reference titles only
      console.log(` ${String(rankStart).padStart(2)}. [TIE — ${currentCount} reference${currentCount !== 1 ? "s" : ""}, ${group.length} contenders]`);
      for (const e of group) {
        const refTitles = e.references.map(r => r.title).join(", ");
        console.log(`     • ${e.title} (${fmtMedia(e.mediaType)}) — ${e.releaseDate || "unknown"}, TMDB ${e.tmdbId}`);
        console.log(`         ← ${refTitles}`);
      }
      console.log();
      rankStart += group.length;
    }

    i = j;
  }
}

function printRankingB(selections) {
  console.log(`\n${SEP}`);
  console.log("  RANKING B: WITH DIVERSITY (graph pruning)");
  console.log(`${SEP}\n`);

  for (let i = 0; i < selections.length; i++) {
    const sel = selections[i];
    const countChanged = sel.count !== sel.originalCount;
    const countStr = countChanged
      ? `${sel.originalCount} references → ${sel.count} after diversity`
      : `${sel.count} reference${sel.count !== 1 ? "s" : ""}`;

    console.log(` ${String(i + 1).padStart(2)}. ${sel.title} (${fmtMedia(sel.mediaType)}) — ${countStr}`);
    console.log(`     Release: ${sel.releaseDate || "unknown"}  |  TMDB ID: ${sel.tmdbId}`);

    if (sel.wasTiebreak) {
      console.log(`     [tiebreaker: alphabetical among ${sel.tiebreakCount} contenders tied at count=${sel.originalCount}]`);
    }

    const refLabel = i > 0 ? "References (surviving after prior diversity rounds):" : "References:";
    console.log(`     ${refLabel}`);
    for (const ref of sel.references) {
      const fav = ref.isFavorite ? ", ★ favorite" : "";
      console.log(`       • ${ref.title} (${ref.status}${fav}, position #${ref.position + 1})`);
    }

    const srcCount = sel.references.length;
    console.log(`     [Diversity: removed ${srcCount} source node${srcCount !== 1 ? "s" : ""} → ${sel.affectedRecs} other recs affected]`);
    console.log();
  }
}

function printComparison(aggregated, diversitySelections, topK) {
  console.log(`${SEP}`);
  console.log("  COMPARISON: RAW vs DIVERSITY");
  console.log(`${SEP}\n`);

  // Build raw ranking as ordered rows (respecting tie groups)
  const sortedRaw = Object.values(aggregated).sort((a, b) => b.count - a.count);

  // rawRankMap: tmdbId -> starting rank of the group it belongs to
  const rawRankMap = new Map();
  const rawRows = []; // { rankStart, label, isTie, tmdbIds }

  let rankStart = 1;
  let i = 0;
  while (i < sortedRaw.length) {
    if (rankStart > topK) break;
    const currentCount = sortedRaw[i].count;
    let j = i;
    while (j < sortedRaw.length && sortedRaw[j].count === currentCount) j++;
    const group = sortedRaw.slice(i, j);
    const tmdbIds = group.map(e => e.tmdbId);
    for (const e of group) rawRankMap.set(e.tmdbId, rankStart);

    if (group.length === 1) {
      rawRows.push({ rankStart, label: `${group[0].title} (${group[0].count})`, isTie: false });
    } else {
      rawRows.push({ rankStart, label: `[${group.length} tied at ${currentCount}]`, isTie: true });
    }

    rankStart += group.length;
    i = j;
  }

  const colW = 30;
  console.log(`  ${"#".padEnd(4)} ${"Raw ranking".padEnd(colW)} ${"Diversity ranking".padEnd(colW)} Change`);
  console.log("  " + "─".repeat(4 + colW + 1 + colW + 1 + 20));

  const rows = Math.max(rawRows.length, diversitySelections.length);

  for (let row = 0; row < rows; row++) {
    const rawRow = rawRows[row];
    const divSel = diversitySelections[row];

    const rankStr = String(row + 1).padStart(3);
    const rawLabel = rawRow ? rawRow.label : "";

    let divLabel = "";
    let changeStr = "";

    if (divSel) {
      const countStr = divSel.count !== divSel.originalCount
        ? `${divSel.originalCount}→${divSel.count}`
        : String(divSel.originalCount);
      divLabel = `${divSel.title} (${countStr})`;

      const rawRankStart = rawRankMap.get(divSel.tmdbId);
      const divRank = row + 1;
      if (rawRankStart === undefined) {
        changeStr = "NEW";
      } else if (rawRankStart === divRank) {
        changeStr = "—";
      } else if (rawRankStart < divRank) {
        changeStr = `↓ from #${rawRankStart}`;
      } else {
        changeStr = `↑ from #${rawRankStart}`;
      }
    }

    console.log(`  ${rankStr} ${rawLabel.slice(0, colW - 1).padEnd(colW)} ${divLabel.slice(0, colW - 1).padEnd(colW)} ${changeStr}`);
  }

  console.log();

  // Titles unique to each ranking
  const rawTopTmdbIds = new Set(rawRankMap.keys());
  const divTmdbIds = new Set(diversitySelections.map(s => s.tmdbId));

  const divOnlyTitles = diversitySelections
    .filter(s => !rawTopTmdbIds.has(s.tmdbId))
    .map(s => s.title);
  const rawOnlyTitles = [...rawTopTmdbIds]
    .filter(id => !divTmdbIds.has(id))
    .map(id => aggregated[id]?.title)
    .filter(Boolean);

  if (divOnlyTitles.length > 0) {
    console.log(`  In diversity top-${topK} but NOT in raw top-${topK}: ${divOnlyTitles.join(", ")}`);
  }
  if (rawOnlyTitles.length > 0) {
    console.log(`  In raw top-${topK} but NOT in diversity top-${topK}: ${rawOnlyTitles.join(", ")}`);
  }
  if (divOnlyTitles.length === 0 && rawOnlyTitles.length === 0) {
    console.log(`  Both rankings contain the same titles.`);
  }
  console.log();
}

function printCountDistribution(aggregated) {
  console.log(`${SEP}`);
  console.log("  FULL COUNT DISTRIBUTION (this list, before diversity)");
  console.log(`${SEP}`);

  const dist = {};
  for (const e of Object.values(aggregated)) {
    dist[e.count] = (dist[e.count] || 0) + 1;
  }

  const maxVal = Math.max(...Object.values(dist));
  const counts = Object.keys(dist).map(Number).sort((a, b) => b - a);

  for (const count of counts) {
    const num = dist[count];
    const refLabel = count === 1 ? "ref: " : "refs:";
    const b = barChart(num, maxVal);
    console.log(`  ${String(count).padStart(3)} ${refLabel}  ${String(num).padStart(5)} titles  ${b}`);
  }
  console.log();
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  // Parse CLI
  const listId = process.argv[2];
  if (!listId || listId.startsWith("--")) {
    console.error("Usage: node scripts/graph-recommend.mjs <listId> [--uid <uid>] [--type movie|show|all] [--top <k>] [--source recs|similar]");
    process.exit(1);
  }

  const uidArgIdx    = process.argv.indexOf("--uid");
  const uid          = uidArgIdx >= 0 ? process.argv[uidArgIdx + 1] : null;

  const typeArgIdx   = process.argv.indexOf("--type");
  const typeFilter   = typeArgIdx >= 0 ? process.argv[typeArgIdx + 1] : "all";

  const topArgIdx    = process.argv.indexOf("--top");
  const topK         = topArgIdx >= 0 ? parseInt(process.argv[topArgIdx + 1], 10) : 10;

  const sourceArgIdx = process.argv.indexOf("--source");
  const source       = sourceArgIdx >= 0 ? process.argv[sourceArgIdx + 1] : "recs";

  if (!["movie", "show", "all"].includes(typeFilter)) {
    console.error(`Invalid --type: "${typeFilter}". Must be movie, show, or all`);
    process.exit(1);
  }
  if (isNaN(topK) || topK < 1) {
    console.error(`Invalid --top: must be a positive integer`);
    process.exit(1);
  }
  if (!["recs", "similar"].includes(source)) {
    console.error(`Invalid --source: "${source}". Must be recs or similar`);
    process.exit(1);
  }

  const FORWARD_INDEX_PATH  = INDEX_PATHS[source].forward;
  const INVERTED_INDEX_PATH = INDEX_PATHS[source].inverted;
  const buildScript = source === "similar" ? "build-similar-cache.mjs" : "build-recs-cache.mjs";

  // 1. Load indices
  for (const [label, path] of [["Forward index", FORWARD_INDEX_PATH], ["Inverted index", INVERTED_INDEX_PATH]]) {
    if (!existsSync(path)) {
      console.error(`${label} not found: ${path}`);
      console.error(`Run: node scripts/${buildScript}`);
      process.exit(1);
    }
  }

  const forwardIndex = JSON.parse(readFileSync(FORWARD_INDEX_PATH, "utf8"));
  const forwardEntries = Object.keys(forwardIndex).length;
  // Inverted index loaded but not used directly — forward index is sufficient for Phase 2
  // (inverted index is kept as a diagnostic artifact from Phase 1)

  // 2. Init Firebase + load titleRegistry
  process.stdout.write("Loading Firestore... ");
  const db = initFirebase();
  const regSnap = await db.collection("titleRegistry").get();
  const registry = {};
  for (const doc of regSnap.docs) registry[doc.id] = doc.data();
  console.log(`${regSnap.docs.length} registry docs`);

  // 3. Resolve list
  const list     = await resolveList(db, listId, uid);
  const listData = list.data;
  const memberUids = list.type === "shared"
    ? extractMemberUids(list.members)
    : (list.uid ? [list.uid] : []);

  // Load favorites from all relevant users
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

  // 4. Build list items with status
  const watched    = new Set(listData.watched    || []);
  const archive    = new Set(listData.archive    || []);
  const maybeLater = new Set(listData.maybeLater || []);

  const listItems = [];
  for (const item of listData.items || []) {
    const rid = item.registryId;
    if (!rid) continue;
    let status = "to-watch";
    if (watched.has(rid))    status = "watched";
    else if (archive.has(rid))    status = "archive";
    else if (maybeLater.has(rid)) status = "maybe-later";
    const reg = registry[rid] || {};
    listItems.push({
      registryId: rid,
      imdbId:     reg.imdbId || null,
      tmdbId:     reg.tmdbId ? String(reg.tmdbId) : null,
      title:      reg.title  || rid,
      status,
      isFavorite: favorites.has(rid),
    });
  }

  // 5. Positive signal: watched + archived items
  const positiveItems = listItems.filter(i => i.status === "watched" || i.status === "archive");
  const watchedCount  = positiveItems.filter(i => i.status === "watched").length;
  const archiveCount  = positiveItems.filter(i => i.status === "archive").length;

  // Header
  const listTypeLabel = list.type === "shared"
    ? `shared, ${memberUids.length} member${memberUids.length !== 1 ? "s" : ""}`
    : "personal";
  console.log(`\n🎬  Watchlist Recommendation Engine v4 (Graph-based)`);
  console.log(`List: ${list.name} (${listTypeLabel})`);
  console.log(`Source: ${source} (${source === "similar" ? "TMDB /similar" : "TMDB /recommendations"})`);
  if (typeFilter !== "all") console.log(`Type filter: ${typeFilter}`);
  console.log(`Positive signal: ${positiveItems.length} titles (${watchedCount} watched, ${archiveCount} archived)`);

  if (positiveItems.length === 0) {
    console.log("No watched/archived titles on this list. Watch something first!");
    process.exit(0);
  }

  // 6. Aggregate recommendations from positive titles
  // aggregated: tmdbId (string) → { tmdbId, title, mediaType, releaseDate, references[], count }
  const aggregated = {};
  let notInForwardIndex = 0;
  let mappedCount = 0;

  for (const item of positiveItems) {
    if (!item.imdbId) {
      notInForwardIndex++;
      continue;
    }
    const entry = forwardIndex[item.imdbId];
    if (!entry) {
      notInForwardIndex++;
      continue;
    }
    mappedCount++;

    let recs = entry.recs || [];
    if (typeFilter === "movie") recs = recs.filter(r => r.mediaType === "movie");
    else if (typeFilter === "show") recs = recs.filter(r => r.mediaType === "tv");

    for (const rec of recs) {
      const key = String(rec.tmdbId);
      if (!aggregated[key]) {
        aggregated[key] = {
          tmdbId:      key,
          title:       rec.title,
          mediaType:   rec.mediaType,
          releaseDate: rec.releaseDate,
          references:  [],
          count:       0,
        };
      }
      aggregated[key].references.push({
        imdbId:     item.imdbId,
        title:      item.title,
        status:     item.status,
        isFavorite: item.isFavorite,
        position:   rec.position,
      });
      aggregated[key].count++;
    }
  }

  if (notInForwardIndex > 0) {
    console.log(`  ${notInForwardIndex} positive title${notInForwardIndex !== 1 ? "s" : ""} not in forward index (no imdbId or not cached)`);
  }
  console.log(`Forward index: ${forwardEntries} entries loaded`);

  // 7. Exclusion: remove recs whose tmdbId matches a watched/archived item on this list
  const rawCandidateCount   = Object.keys(aggregated).length;
  let totalRefsRaw = 0;
  for (const e of Object.values(aggregated)) totalRefsRaw += e.count;

  let noTmdbIdSkipped = 0;
  for (const item of listItems) {
    if (item.status !== "watched" && item.status !== "archive") continue;
    if (!item.tmdbId) { noTmdbIdSkipped++; continue; }
    delete aggregated[item.tmdbId];
  }
  if (noTmdbIdSkipped > 0) {
    console.log(`  Note: ${noTmdbIdSkipped} watched/archived item${noTmdbIdSkipped !== 1 ? "s" : ""} had no tmdbId — could not exclude by tmdbId`);
  }

  const afterExclusionCount = Object.keys(aggregated).length;

  // Count distribution
  const dist = { 1: 0, 2: 0, 3: 0, "4+": 0 };
  for (const e of Object.values(aggregated)) {
    if      (e.count === 1) dist[1]++;
    else if (e.count === 2) dist[2]++;
    else if (e.count === 3) dist[3]++;
    else                    dist["4+"]++;
  }

  console.log(`\nRecommendation graph for this list:`);
  console.log(`  ${mappedCount} positive titles mapped to forward index`);
  console.log(`  Raw recommendations: ${totalRefsRaw} total, ${rawCandidateCount} unique candidates`);
  console.log(`  After excluding watched/archived: ${afterExclusionCount} candidates`);
  console.log(`  Count distribution (this list):`);
  console.log(`    1 ref:  ${String(dist[1]).padStart(5)} titles`);
  console.log(`    2 refs: ${String(dist[2]).padStart(5)} titles`);
  console.log(`    3 refs: ${String(dist[3]).padStart(5)} titles`);
  console.log(`    4+ refs:${String(dist["4+"]).padStart(5)} titles`);

  if (afterExclusionCount === 0) {
    console.log("\nNo recommendation candidates after exclusion.");
    process.exit(0);
  }

  // 8. Ranking A — Raw
  printRankingA(aggregated, topK);

  // 9. Ranking B — Diversity
  const diversitySelections = runDiversityRanking(aggregated, topK);
  printRankingB(diversitySelections);

  // 10. Comparison
  printComparison(aggregated, diversitySelections, topK);

  // 11. Full count distribution
  printCountDistribution(aggregated);

  process.exit(0);
}

main().catch(err => { console.error("\nError:", err.message); process.exit(1); });
