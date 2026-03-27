/**
 * Backfill missing `thumb` on `titleRegistry` docs using TMDB `poster_path` (w500).
 *
 *   node scripts/backfill-thumb.mjs              # dry run (default)
 *   node scripts/backfill-thumb.mjs --dry-run  # explicit dry run
 *   node scripts/backfill-thumb.mjs --write    # merge `thumb` into Firestore
 *
 * Requires `.env`: TMDB_API_KEY, FIREBASE_SERVICE_ACCOUNT (base64); or `serviceAccountKey.json`.
 */
import "dotenv/config";
import { getDb } from "./lib/admin-init.mjs";

const DOC_IDS = [
  "tt23221806",
  "tt29494111",
  "tt31019484",
  "tt31192372",
  "tt31709373",
  "tt32253092",
  "tt3350890",
  "tt3398228",
];

const TMDB_IMG_BASE = "https://image.tmdb.org/t/p/w500";

const args = process.argv.slice(2);
const dryRun = !args.includes("--write");

const apiKey = process.env.TMDB_API_KEY;
if (!apiKey) {
  console.error("Set TMDB_API_KEY in .env");
  process.exit(1);
}

const db = getDb();
const col = db.collection("titleRegistry");

function hasThumb(data) {
  if (!data || typeof data !== "object") return false;
  const v = data.thumb;
  return v != null && String(v).trim() !== "";
}

/** @returns {'movie'|'tv'|null} */
function resolveTmdbMedia(data) {
  const m = data?.tmdbMedia;
  if (m === "movie" || m === "tv") return m;
  const t = data?.type;
  if (t === "movie") return "movie";
  if (t === "show") return "tv";
  return null;
}

async function fetchTmdbDetails(media, tmdbId) {
  const url = `https://api.themoviedb.org/3/${media}/${encodeURIComponent(String(tmdbId))}?api_key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.status_message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

for (const id of DOC_IDS) {
  const ref = col.doc(id);
  const snap = await ref.get();
  if (!snap.exists) {
    console.warn(`⚠ skip ${id} — document missing`);
    continue;
  }
  const data = snap.data();
  const title = data?.title ?? id;

  if (hasThumb(data)) {
    console.log(`→ ${title} already has thumb`);
    continue;
  }

  const tmdbId = data?.tmdbId;
  if (tmdbId == null) {
    console.warn(`⚠ ${title} — no tmdbId, skipping`);
    continue;
  }

  const media = resolveTmdbMedia(data);
  if (media == null) {
    console.warn(`⚠ ${title} — cannot derive tmdbMedia/type, skipping`);
    continue;
  }

  let details;
  try {
    details = await fetchTmdbDetails(media, tmdbId);
  } catch (e) {
    console.warn(`⚠ ${title} — TMDB request failed: ${e?.message || e}`);
    continue;
  }

  const posterPath = details?.poster_path;
  if (!posterPath || typeof posterPath !== "string") {
    console.warn(`⚠ ${title} — no poster found, skipping`);
    continue;
  }

  const thumbUrl = `${TMDB_IMG_BASE}${posterPath}`;

  if (dryRun) {
    console.log(`[dry-run] ✓ ${title} — would set thumb to ${thumbUrl}`);
  } else {
    await ref.set({ thumb: thumbUrl }, { merge: true });
    console.log(`✓ ${title} — ${thumbUrl}`);
  }
}

if (dryRun) {
  console.log("\nDry run only. Re-run with --write to apply.");
}
