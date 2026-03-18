/**
 * Update a movie in Firestore catalog.
 * Run: node scripts/update-movie.js "Man on the Inside" xhsVj_4ONoA
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

async function updateMovie(title, youtubeId) {
  const ref = db.collection("catalog").doc("movies");
  const snap = await ref.get();
  if (!snap.exists || !Array.isArray(snap.data().items)) {
    console.error("Catalog not found.");
    process.exit(1);
  }
  const items = snap.data().items;
  const idx = items.findIndex(
    (m) => m.title.toLowerCase() === title.toLowerCase()
  );
  if (idx === -1) {
    console.error(`Movie "${title}" not found.`);
    process.exit(1);
  }
  items[idx].youtubeId = youtubeId;
  if (youtubeId === "SEARCH") {
    delete items[idx].thumb;
  } else {
    items[idx].thumb = `https://img.youtube.com/vi/${youtubeId}/hqdefault.jpg`;
  }
  await ref.set({
    items,
    updatedAt: new Date().toISOString(),
  });
  console.log(`Updated "${items[idx].title}" youtubeId to ${youtubeId}`);
}

const [, , title, youtubeId] = process.argv;
if (!title || !youtubeId) {
  console.error('Usage: node scripts/update-movie.js "Movie Title" youtubeId');
  process.exit(1);
}

updateMovie(title, youtubeId).catch((err) => {
  console.error(err);
  process.exit(1);
});
