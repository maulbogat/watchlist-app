/**
 * Update a movie's year in Firestore catalog.
 * Run: node scripts/update-year.js "Title" year
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const key = JSON.parse(readFileSync(join(rootDir, "serviceAccountKey.json"), "utf-8"));
const app = initializeApp({ credential: cert(key) });
const db = getFirestore(app);

const [, , title, year] = process.argv;
if (!title || year === undefined) {
  console.error('Usage: node scripts/update-year.js "Title" year');
  process.exit(1);
}

const ref = db.collection("catalog").doc("movies");
const snap = await ref.get();
if (!snap.exists || !Array.isArray(snap.data().items)) {
  console.error("Catalog not found.");
  process.exit(1);
}
const items = snap.data().items;
const idx = items.findIndex((m) => m.title === title);
if (idx === -1) {
  console.error(`"${title}" not found.`);
  process.exit(1);
}
items[idx].year = Number(year) || null;
await ref.set({ items, updatedAt: new Date().toISOString() });
console.log(`Updated "${title}" year to ${year}`);
