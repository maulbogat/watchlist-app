/**
 * Add a movie to the Firestore catalog.
 * Run: node scripts/add-movie.js "Title" [year] [type] [youtubeId]
 * Example: node scripts/add-movie.js "10 קילו קוקאין" 2025 movie
 *
 * If youtubeId omitted, uses "SEARCH" (user can search YouTube).
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

async function addMovie(title, year, type, youtubeId) {
  const ref = db.collection("catalog").doc("movies");
  const snap = await ref.get();
  if (!snap.exists || !Array.isArray(snap.data().items)) {
    console.error("Catalog not found.");
    process.exit(1);
  }
  const items = snap.data().items;
  const exists = items.some((m) => m.title === title && (m.year ?? "") === String(year ?? ""));
  if (exists) {
    console.error(`"${title}" (${year}) already in catalog.`);
    process.exit(1);
  }
  const yt = youtubeId || "SEARCH";
  const movie = {
    title,
    year: year ? Number(year) : null,
    type: type === "show" ? "show" : "movie",
    genre: "Drama / Crime",
    youtubeId: yt,
    services: [],
  };
  if (yt !== "SEARCH") {
    movie.thumb = `https://img.youtube.com/vi/${yt}/hqdefault.jpg`;
  }
  items.push(movie);
  await ref.set({
    items,
    updatedAt: new Date().toISOString(),
  });
  console.log(`Added "${title}" (${year || "—"}) to catalog.`);
}

const [, , title, year, type, youtubeId] = process.argv;
if (!title) {
  console.error('Usage: node scripts/add-movie.js "Title" [year] [type] [youtubeId]');
  process.exit(1);
}

addMovie(title, year, type, youtubeId).catch((err) => {
  console.error(err);
  process.exit(1);
});
