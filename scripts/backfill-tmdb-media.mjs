/**
 * Backfill `tmdbMedia` on `titleRegistry` docs that have `tmdbId` but omitted `tmdbMedia`,
 * derived from `type` (no TMDB API).
 *
 *   node scripts/backfill-tmdb-media.mjs              # dry run (default)
 *   node scripts/backfill-tmdb-media.mjs --write
 *
 * Requires: FIREBASE_SERVICE_ACCOUNT (base64) or serviceAccountKey.json (repo root).
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const keyPath = join(rootDir, "serviceAccountKey.json");

const DOC_IDS = [
  "tt0285403",
  "tt11514868",
  "tt12001534",
  "tt12593682",
  "tt14364480",
  "tt1520211",
  "tt15677150",
  "tt1618434",
  "tt19811010",
  "tt19891306",
  "tt2950342",
  "tt30423279",
  "tt31937954",
  "tt35997699",
  "tt39572794",
  "tt6043142",
  "tt7520794",
  "tt8398600",
  "tt8946378",
];

const args = process.argv.slice(2);
const dryRun = !args.includes("--write");

let app;
try {
  let key;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    key = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, "base64").toString("utf-8"));
  } else {
    key = JSON.parse(readFileSync(keyPath, "utf-8"));
  }
  app = initializeApp({ credential: cert(key) });
} catch {
  console.error("Need Firebase credentials:");
  console.error("  FIREBASE_SERVICE_ACCOUNT (base64) or serviceAccountKey.json in project root.");
  process.exit(1);
}

const db = getFirestore(app);
const col = db.collection("titleRegistry");

function hasTmdbMedia(data) {
  if (!data || typeof data !== "object") return false;
  const v = data.tmdbMedia;
  return v != null && String(v).trim() !== "";
}

function typeToTmdbMedia(type) {
  if (type === "movie") return "movie";
  if (type === "show") return "tv";
  return null;
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

  if (hasTmdbMedia(data)) {
    console.log(`→ ${title} already has tmdbMedia`);
    continue;
  }

  const tmdbMedia = typeToTmdbMedia(data?.type);
  if (tmdbMedia == null) {
    console.warn(`⚠ skip ${title} (${id}) — unexpected type: ${JSON.stringify(data?.type)}`);
    continue;
  }

  if (dryRun) {
    console.log(`[dry-run] ✓ ${title} — would set tmdbMedia to ${tmdbMedia}`);
  } else {
    await ref.set({ tmdbMedia }, { merge: true });
    console.log(`✓ ${title} — tmdbMedia set to ${tmdbMedia}`);
  }
}

if (dryRun) {
  console.log("\nDry run only. Re-run with --write to apply.");
}
