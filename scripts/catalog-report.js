/**
 * Report on catalog: missing trailers, missing thumbnails, Israeli titles.
 * Run: node scripts/catalog-report.js
 * Requires: serviceAccountKey.json in project root.
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const keyPath = join(rootDir, "serviceAccountKey.json");

let app;
try {
  const key = JSON.parse(readFileSync(keyPath, "utf-8"));
  app = initializeApp({ credential: cert(key) });
} catch (e) {
  console.error("Create serviceAccountKey.json in project root.");
  process.exit(1);
}

const db = getFirestore(app);

function hasHebrew(text) {
  return /[\u0590-\u05FF]/.test(String(text || ""));
}

function isIsraeli(m) {
  const title = String(m.title || "");
  const genre = String(m.genre || "").toLowerCase();
  return hasHebrew(title) || genre.includes("israel") || genre.includes("israeli");
}

async function run() {
  const ref = db.collection("catalog").doc("movies");
  const snap = await ref.get();
  if (!snap.exists || !Array.isArray(snap.data().items)) {
    console.error("Catalog not found.");
    process.exit(1);
  }
  const items = snap.data().items;

  const missingTrailer = items.filter(
    (m) => !m.youtubeId || m.youtubeId === "SEARCH"
  );
  const missingThumb = items.filter(
    (m) => !m.thumb || (m.youtubeId === "SEARCH" && !m.thumb)
  );
  const israeli = items.filter(isIsraeli);

  console.log("\n=== Missing trailers (youtubeId empty or SEARCH) ===\n");
  if (!missingTrailer.length) {
    console.log("None.");
  } else {
    missingTrailer.forEach((m) =>
      console.log(`  ${m.title} (${m.year ?? "—"}) [${m.type || "movie"}]`)
    );
  }

  console.log("\n=== Missing thumbnails ===\n");
  if (!missingThumb.length) {
    console.log("None.");
  } else {
    missingThumb.forEach((m) =>
      console.log(`  ${m.title} (${m.year ?? "—"}) [${m.type || "movie"}]`)
    );
  }

  console.log("\n=== Israeli titles (Hebrew in title or Israel in genre) ===\n");
  if (!israeli.length) {
    console.log("None.");
  } else {
    israeli.forEach((m) =>
      console.log(`  ${m.title} (${m.year ?? "—"}) [${m.type || "movie"}] ${m.genre || ""}`)
    );
  }

  console.log("\n--- Summary ---");
  console.log(`Total: ${items.length}`);
  console.log(`Missing trailer: ${missingTrailer.length}`);
  console.log(`Missing thumb: ${missingThumb.length}`);
  console.log(`Israeli: ${israeli.length}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
