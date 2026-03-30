/**
 * Watchlist — IMDb Watch History Import
 *
 * Imports a list of IMDb IDs as archived titles into the user's default personal list.
 *
 * Run (dry run):  node scripts/import-imdb-watched.mjs <uid>
 * Run (write):    node scripts/import-imdb-watched.mjs <uid> --write
 *
 * Requires: FIREBASE_SERVICE_ACCOUNT, TMDB_API_KEY, OMDB_API_KEY in .env
 */

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import https from "https";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "../.env") });

// ─── IMDb IDs to import ───────────────────────────────────────────────────────
// Extracted from https://www.imdb.com/user/ur158240045/watchhistory/

const IMDB_IDS = [
  "tt0088847","tt0312141","tt0118883","tt1285016","tt1156398","tt3377134","tt0480249",
  "tt0116629","tt0119654","tt0098800","tt0343818","tt0088247","tt0073052","tt0374053",
  "tt0087332","tt0114709","tt0397442","tt0078788","tt0467406","tt2637276","tt1637725",
  "tt0149460","tt0386676","tt1826940","tt0369610","tt0114814","tt0117438","tt0112864",
  "tt0099423","tt0120812","tt0158421","tt0378194","tt0119396","tt1028528","tt0236493",
  "tt0985694","tt0117571","tt0108778","tt0098904","tt0399295","tt0120832","tt0105236",
  "tt0253867","tt0129387","tt0181865","tt0259711","tt0117060","tt0092099","tt0120382",
  "tt0119528","tt0109686","tt0338013","tt0169547","tt1856010","tt23055142","tt21382296",
  "tt5071412","tt2948356","tt0367279","tt3960412","tt1231587","tt0087538","tt0087469",
  "tt15677150","tt0460649","tt0093409","tt0407887","tt0369179","tt0165598","tt0182576",
  "tt1772341","tt0092400","tt13586986","tt13956724","tt0904992","tt1675197","tt0385411",
  "tt13464060","tt1405737","tt14426644","tt39781131","tt1258123","tt4565380","tt36195733",
  "tt28079116","tt0097733","tt0099141","tt0104714","tt8421350","tt0299658","tt0441773",
  "tt0266697","tt0361748","tt2085059","tt3566726","tt0113101","tt0298148","tt0115082",
  "tt0086960","tt0117218","tt0126029","tt0110475","tt0109040","tt0397892","tt0110912",
  "tt2861424","tt6524350","tt14269590","tt13443470","tt3890160","tt8796226","tt34850760",
  "tt13660638","tt4407996","tt2604320","tt1245492","tt13366604","tt14271498","tt13434148",
  "tt15325794","tt10795658","tt2249364","tt8064302","tt0892535","tt6474378","tt9817298",
  "tt7767422","tt9612516","tt10919420","tt8740614","tt6143796","tt1618434","tt11564570",
  "tt8946378","tt16431870","tt23856194","tt4834206","tt0094721","tt0159273","tt3398228",
  "tt2467372","tt12593682","tt7221388","tt4094300","tt0348913","tt4047038","tt11286314",
  "tt0119094","tt5565334","tt0077631","tt0107048","tt2452242","tt3095080","tt3205802",
  "tt11167448","tt0805663","tt0411008","tt4189492","tt9484998","tt4744372","tt5580540",
  "tt0446029","tt13640696","tt0112167","tt28660296","tt2854926","tt0245844","tt6257970",
  "tt1684562","tt1119646","tt1411697","tt1951261","tt0117500","tt0103112","tt7335184",
  "tt0128853","tt0118880","tt0137523","tt0120586","tt0095016","tt1305806","tt14209916",
  "tt0141926","tt0114069","tt2184339","tt1632701","tt0120689","tt0106977","tt5143226",
  "tt3464902","tt1542344","tt0773262","tt5189670","tt0903747","tt0237123","tt0112851",
  "tt0117381","tt1596363","tt3339966","tt6575296","tt0211915","tt0105435","tt1553656",
  "tt2788710","tt0096874","tt0099088","tt0088763","tt1442437","tt0993846","tt0813715",
  "tt0455275","tt0208092","tt1475582","tt1045778","tt16124614","tt4477976","tt4270492",
  "tt0094862","tt8220344","tt7130300","tt1727770","tt1219289","tt2707408","tt34888633",
  "tt23649128","tt0475784","tt0960144","tt0804503","tt1560220","tt0478087","tt0910936",
  "tt15474916","tt0050083","tt11280740","tt27846061","tt8772296","tt30827810",
];

const WRITE_MODE = process.argv.includes("--write");
const DELAY_MS = 350; // delay between TMDB calls to stay under rate limit

// ─── Firebase ─────────────────────────────────────────────────────────────────

function initFirebase() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT not set in .env");
  const key = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
  const app = initializeApp({ credential: cert(key), projectId: key.project_id });
  return getFirestore(app);
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error for ${url}: ${e.message}`)); }
      });
    }).on("error", reject);
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── TMDB enrichment ──────────────────────────────────────────────────────────

const TMDB_IMG = "https://image.tmdb.org/t/p/w500";

async function enrichFromTmdb(imdbId, tmdbKey) {
  const findUrl = `https://api.themoviedb.org/3/find/${imdbId}?external_source=imdb_id&api_key=${tmdbKey}`;
  const find = await fetchJson(findUrl);

  const movie = find.movie_results?.[0];
  const tv = find.tv_results?.[0];
  if (!movie && !tv) return null;

  // Prefer movie if both exist (for watch history, most are movies)
  const mediaType = movie ? "movie" : "tv";
  const item = movie || tv;
  const id = item.id;

  const detailUrl = `https://api.themoviedb.org/3/${mediaType}/${id}?append_to_response=videos&api_key=${tmdbKey}`;
  const detail = await fetchJson(detailUrl);

  const title = mediaType === "movie"
    ? (detail.title || detail.original_title || "")
    : (detail.name || detail.original_name || "");

  let year = null;
  const dateStr = mediaType === "movie" ? detail.release_date : detail.first_air_date;
  if (dateStr && dateStr.length >= 4) year = parseInt(dateStr.slice(0, 4));

  const genres = (detail.genres || []).map(g => g.name).filter(Boolean);
  const genre = genres.join(" / ");
  const thumb = detail.poster_path ? `${TMDB_IMG}${detail.poster_path}` : null;
  const originalLanguage = detail.original_language || null;

  // YouTube trailer
  const videos = detail.videos?.results || [];
  const trailer = videos.find(v => v.site === "YouTube" && v.type === "Trailer")
    || videos.find(v => v.site === "YouTube");
  const youtubeId = trailer?.key || null;

  return {
    title,
    year,
    type: mediaType === "movie" ? "movie" : "show",
    genre,
    thumb,
    youtubeId,
    imdbId,
    tmdbId: id,
    tmdbMedia: mediaType,
    originalLanguage,
    services: [],
  };
}

async function enrichFromOmdb(imdbId, omdbKey) {
  const url = `https://www.omdbapi.com/?i=${imdbId}&apikey=${omdbKey}`;
  const data = await fetchJson(url);
  if (data.Response === "False") return null;

  const title = data.Title || "Unknown";
  let year = null;
  const yearStr = String(data.Year || "").replace(/\D/g, "").slice(0, 4);
  if (yearStr.length === 4) year = parseInt(yearStr);

  return {
    title,
    year,
    type: data.Type === "series" ? "show" : "movie",
    genre: data.Genre || "",
    thumb: data.Poster && data.Poster !== "N/A" ? data.Poster : null,
    youtubeId: null,
    imdbId,
    tmdbId: null,
    tmdbMedia: null,
    originalLanguage: null,
    services: [],
  };
}

// ─── Registry ID (mirrors src/api-lib/registry-id.cjs) ───────────────────────

function registryDocId(imdbId) {
  return imdbId.startsWith("tt") ? imdbId : `tt${imdbId}`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const uid = process.argv[2];
  if (!uid) {
    console.error("Usage: node scripts/import-imdb-watched.mjs <uid> [--write]");
    process.exit(1);
  }

  const tmdbKey = process.env.TMDB_API_KEY;
  const omdbKey = process.env.OMDB_API_KEY;
  if (!tmdbKey) { console.error("TMDB_API_KEY not set"); process.exit(1); }
  if (!omdbKey) { console.error("OMDB_API_KEY not set"); process.exit(1); }

  console.log(`\n📥  IMDb Watch History Import`);
  console.log(`Mode: ${WRITE_MODE ? "✍️  WRITE" : "🔍 DRY RUN"}`);
  console.log(`User: ${uid}`);
  console.log(`Titles to import: ${IMDB_IDS.length}\n`);

  const db = initFirebase();

  // Load existing titleRegistry (check which IDs already exist)
  process.stdout.write("Loading titleRegistry... ");
  const regSnap = await db.collection("titleRegistry").select("imdbId", "title", "listStatus").get();
  const registryByImdbId = {};
  for (const doc of regSnap.docs) {
    const data = doc.data();
    if (data.imdbId) registryByImdbId[data.imdbId] = { id: doc.id, ...data };
  }
  console.log(`${Object.keys(registryByImdbId).length} existing docs\n`);

  // Load user's default personal list
  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) { console.error(`User not found: ${uid}`); process.exit(1); }
  const defaultListId = userSnap.data().defaultPersonalListId;
  if (!defaultListId) { console.error("No defaultPersonalListId on user"); process.exit(1); }

  const listRef = userRef.collection("personalLists").doc(defaultListId);
  const listSnap = await listRef.get();
  if (!listSnap.exists) { console.error(`Personal list not found: ${defaultListId}`); process.exit(1); }
  const listData = listSnap.data();
  const existingItems = listData.items || [];
  const existingArchive = new Set(listData.archive || []);
  const existingWatched = new Set(listData.watched || []);

  // Build set of existing registryIds in list
  const existingRegistryIds = new Set(existingItems.map(i => i.registryId).filter(Boolean));
  // Also index existing items by imdbId for quick lookup
  const existingByImdbId = {};
  for (const item of existingItems) {
    if (item.registryId) existingByImdbId[item.registryId] = item;
  }

  console.log(`List "${listData.name}": ${existingItems.length} items, ${existingArchive.size} archived\n`);
  console.log("─".repeat(65));

  // Process each IMDb ID
  const results = {
    alreadyArchived: [],
    movedToArchive: [],      // already in list but not archived
    newEnriched: [],         // not in registry, enriched and added
    skippedNoData: [],       // couldn't enrich
    errors: [],
  };

  const newItems = [];        // new items to add to list.items
  const archiveToAdd = [];    // registryIds to add to list.archive
  const registryWrites = [];  // { id, data } to write to titleRegistry

  for (let i = 0; i < IMDB_IDS.length; i++) {
    const imdbId = IMDB_IDS[i];
    const registryId = registryDocId(imdbId);

    process.stdout.write(`[${(i+1).toString().padStart(3)}/${IMDB_IDS.length}] ${imdbId} `);

    try {
      // Case 1: already in registry AND in list
      if (existingRegistryIds.has(registryId)) {
        if (existingArchive.has(registryId)) {
          console.log(`→ already archived ✓`);
          results.alreadyArchived.push(imdbId);
          continue;
        }
        // In list but not archived — move to archive
        console.log(`→ in list, moving to archive`);
        results.movedToArchive.push(imdbId);
        archiveToAdd.push(registryId);
        continue;
      }

      // Case 2: in registry but not in list
      if (registryByImdbId[imdbId]) {
        const reg = registryByImdbId[imdbId];
        console.log(`→ in registry as "${reg.title}", adding to archive`);
        results.movedToArchive.push(imdbId);
        newItems.push({ registryId, addedAt: new Date().toISOString() });
        archiveToAdd.push(registryId);
        continue;
      }

      // Case 3: not in registry — enrich from TMDB then OMDb
      let enriched = null;
      try {
        enriched = await enrichFromTmdb(imdbId, tmdbKey);
        await sleep(DELAY_MS);
      } catch (e) {
        console.log(`(TMDB error: ${e.message}) `);
      }

      if (!enriched) {
        try {
          enriched = await enrichFromOmdb(imdbId, omdbKey);
        } catch (e) {
          console.log(`(OMDb error: ${e.message}) `);
        }
      }

      if (!enriched || !enriched.title) {
        console.log(`→ ⚠️  no data found, skipping`);
        results.skippedNoData.push(imdbId);
        continue;
      }

      console.log(`→ enriched: "${enriched.title}" (${enriched.year}) [${enriched.type}]`);
      results.newEnriched.push({ imdbId, title: enriched.title, year: enriched.year });

      // Queue registry write
      const { title, year, type, genre, thumb, youtubeId, tmdbId, tmdbMedia, originalLanguage, services } = enriched;
      registryWrites.push({
        id: registryId,
        data: { title, year, type, genre, thumb, youtubeId, imdbId, tmdbId, tmdbMedia, originalLanguage, services, listStatus: "archive" },
      });

      // Queue list item
      newItems.push({ registryId, addedAt: new Date().toISOString() });
      archiveToAdd.push(registryId);

    } catch (err) {
      console.log(`→ ❌ error: ${err.message}`);
      results.errors.push({ imdbId, error: err.message });
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(65));
  console.log("  SUMMARY");
  console.log("═".repeat(65));
  console.log(`  Already archived:     ${results.alreadyArchived.length}`);
  console.log(`  Moving to archive:    ${results.movedToArchive.length}`);
  console.log(`  New titles enriched:  ${results.newEnriched.length}`);
  console.log(`  Skipped (no data):    ${results.skippedNoData.length}`);
  console.log(`  Errors:               ${results.errors.length}`);
  console.log(`  Total writes needed:  ${registryWrites.length + (archiveToAdd.length > 0 ? 1 : 0)}`);

  if (results.skippedNoData.length > 0) {
    console.log(`\n  Skipped IDs: ${results.skippedNoData.join(", ")}`);
  }
  if (results.errors.length > 0) {
    console.log(`\n  Errors:`);
    for (const e of results.errors) console.log(`    ${e.imdbId}: ${e.error}`);
  }

  if (!WRITE_MODE) {
    console.log("\n  DRY RUN — no changes made.");
    console.log("  Run with --write to apply.\n");
    process.exit(0);
  }

  // ── Write to Firestore ─────────────────────────────────────────────────────
  console.log("\n  Writing to Firestore...");

  // Batch write titleRegistry docs
  if (registryWrites.length > 0) {
    let batch = db.batch();
    let n = 0;
    for (const { id, data } of registryWrites) {
      batch.set(db.collection("titleRegistry").doc(id), data, { merge: true });
      n++;
      if (n >= 400) {
        await batch.commit();
        batch = db.batch();
        n = 0;
      }
    }
    if (n > 0) await batch.commit();
    console.log(`  ✓ ${registryWrites.length} titleRegistry docs written`);
  }

  // Update listStatus for moved-to-archive items already in registry
  if (results.movedToArchive.length > 0) {
    let batch = db.batch();
    let n = 0;
    for (const imdbId of results.movedToArchive) {
      const registryId = registryDocId(imdbId);
      if (registryByImdbId[imdbId]) {
        // Only update listStatus for existing registry docs not just written above
        const alreadyWritten = registryWrites.find(w => w.id === registryId);
        if (!alreadyWritten) {
          batch.set(db.collection("titleRegistry").doc(registryId),
            { listStatus: "archive" }, { merge: true });
          n++;
          if (n >= 400) {
            await batch.commit();
            batch = db.batch();
            n = 0;
          }
        }
      }
    }
    if (n > 0) await batch.commit();
  }

  // Update personal list
  if (newItems.length > 0 || archiveToAdd.length > 0) {
    const updatedItems = [
      ...existingItems,
      ...newItems,
    ];
    const updatedArchive = [
      ...(listData.archive || []),
      ...archiveToAdd.filter(id => !existingArchive.has(id)),
    ];

    await listRef.set({
      items: updatedItems,
      archive: updatedArchive,
    }, { merge: true });

    console.log(`  ✓ Personal list updated: +${newItems.length} items, +${archiveToAdd.filter(id => !existingArchive.has(id)).length} archived`);
  }

  console.log("\n  ✅ Import complete!\n");
  process.exit(0);
}

main().catch(err => {
  console.error("\nFatal error:", err.message);
  process.exit(1);
});
