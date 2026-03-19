/**
 * Add imdbId to a movie in Firestore catalog.
 * Run: node scripts/add-imdb-to-movie.js "Runt" 2021 tt6988296
 *
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

function normImdb(id) {
  const s = String(id).trim();
  return s.startsWith("tt") ? s : `tt${s}`;
}

async function addImdbToMovie(title, year, imdbId) {
  const ref = db.collection("catalog").doc("movies");
  const snap = await ref.get();
  if (!snap.exists || !Array.isArray(snap.data().items)) {
    console.error("Catalog not found.");
    process.exit(1);
  }
  const items = snap.data().items;
  const idx = items.findIndex(
    (m) =>
      String(m.title).trim().toLowerCase() === String(title).trim().toLowerCase() &&
      String(m.year ?? "") === String(year ?? "")
  );
  if (idx === -1) {
    console.error(`Movie "${title}" (${year}) not found.`);
    process.exit(1);
  }
  items[idx].imdbId = normImdb(imdbId);
  await ref.set({
    items,
    updatedAt: new Date().toISOString(),
  });
  console.log(`Added imdbId ${items[idx].imdbId} to "${items[idx].title}" (${year})`);
}

const [, , title, year, imdbId] = process.argv;
if (!title || !year || !imdbId) {
  console.error('Usage: node scripts/add-imdb-to-movie.js "Movie Title" year imdbId');
  process.exit(1);
}

addImdbToMovie(title, year, imdbId).catch((err) => {
  console.error(err);
  process.exit(1);
});
