/**
 * Remove a movie from the Firestore catalog.
 * Run: node scripts/remove-movie.js "Title" [year]
 * Removes the first match. Use year to target a specific one.
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
if (!title) {
  console.error('Usage: node scripts/remove-movie.js "Title" [year]');
  process.exit(1);
}

const ref = db.collection("catalog").doc("movies");
const snap = await ref.get();
if (!snap.exists || !Array.isArray(snap.data().items)) {
  console.error("Catalog not found.");
  process.exit(1);
}
const items = snap.data().items;
const matches = items.filter(
  (m) =>
    m.title.toLowerCase() === title.toLowerCase() &&
    (year == null || String(m.year ?? "") === String(year))
);
if (matches.length === 0) {
  console.error(`"${title}" not found.`);
  process.exit(1);
}
// Remove first match
const toRemove = matches[0];
const idx = items.findIndex((m) => m === toRemove);
items.splice(idx, 1);
await ref.set({ items, updatedAt: new Date().toISOString() });
console.log(`Removed "${toRemove.title}" (${toRemove.year ?? "—"})`);
