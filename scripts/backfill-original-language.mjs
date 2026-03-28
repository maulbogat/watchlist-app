/**
 * Backfill `originalLanguage` on `titleRegistry` from TMDB `detail.original_language`
 * for docs with `tmdbId` that are missing `originalLanguage` (unless `--force`).
 *
 *   node -r dotenv/config scripts/backfill-original-language.mjs              # dry run
 *   node -r dotenv/config scripts/backfill-original-language.mjs --write       # merge to Firestore
 *   node -r dotenv/config scripts/backfill-original-language.mjs --write --force  # overwrite existing
 *
 * Requires: `TMDB_API_KEY` in `.env`, and `FIREBASE_SERVICE_ACCOUNT` (base64) or `serviceAccountKey.json`.
 */
import { getDb } from "./lib/admin-init.mjs";

const args = process.argv.slice(2);
const dryRun = !args.includes("--write");
const force = args.includes("--force");

const apiKey = (process.env.TMDB_API_KEY || "").trim();
if (!apiKey) {
  console.error("Set TMDB_API_KEY (e.g. node -r dotenv/config scripts/backfill-original-language.mjs)");
  process.exit(1);
}

const db = getDb();
const col = db.collection("titleRegistry");

/** @param {Record<string, unknown> | undefined} data */
function mediaPath(data) {
  const id = Number(data?.tmdbId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const tm = data?.tmdbMedia;
  if (tm === "tv") return { path: "tv", id };
  if (tm === "movie") return { path: "movie", id };
  if (data?.type === "show") return { path: "tv", id };
  return { path: "movie", id };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {string} path
 * @param {number} id
 * @returns {Promise<string | null>}
 */
async function fetchOriginalLanguage(path, id) {
  const url = `https://api.themoviedb.org/3/${path}/${id}?api_key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`TMDB HTTP ${res.status}: ${text.slice(0, 180)}`);
  }
  const json = await res.json();
  const ol = json.original_language;
  if (typeof ol !== "string" || !ol.trim()) return null;
  return ol.trim().toLowerCase();
}

console.log(dryRun ? "Dry run (no Firestore writes). Use --write to apply.\n" : "Writing merges to titleRegistry…\n");

const snap = await col.get();
let updated = 0;
let skippedHasLang = 0;
let skippedNoTmdb = 0;
let failed = 0;

for (const doc of snap.docs) {
  const d = doc.data();
  const label = d?.title ? `${d.title} (${doc.id})` : doc.id;
  const hasOl =
    d?.originalLanguage != null && String(d.originalLanguage).trim() !== "";
  if (hasOl && !force) {
    skippedHasLang += 1;
    continue;
  }
  const mp = mediaPath(d);
  if (!mp) {
    skippedNoTmdb += 1;
    continue;
  }
  try {
    const ol = await fetchOriginalLanguage(mp.path, mp.id);
    await sleep(35);
    if (ol == null) {
      console.warn(`⚠ ${label} — TMDB returned no original_language`);
      failed += 1;
      continue;
    }
    if (dryRun) {
      console.log(`[dry-run] ${label} → originalLanguage: "${ol}"`);
    } else {
      await doc.ref.set({ originalLanguage: ol }, { merge: true });
      console.log(`✓ ${label} → originalLanguage: "${ol}"`);
    }
    updated += 1;
  } catch (e) {
    console.error(`✗ ${label}:`, e instanceof Error ? e.message : e);
    failed += 1;
  }
}

console.log("\n--- Summary ---");
console.log(dryRun ? "Would update (dry run):" : "Updated:", updated);
console.log("Skipped (already had originalLanguage):", skippedHasLang);
console.log("Skipped (no usable tmdbId / media path):", skippedNoTmdb);
console.log("Failed / no language from TMDB:", failed);
console.log("Total titleRegistry docs:", snap.size);
