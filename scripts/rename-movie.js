/**
 * Rename a movie in Firestore catalog.
 * Run: node scripts/rename-movie.js "Old Title" "New Title"
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

const [, , oldTitle, newTitle] = process.argv;
if (!oldTitle || !newTitle) {
  console.error('Usage: node scripts/rename-movie.js "Old Title" "New Title"');
  process.exit(1);
}

const ref = db.collection("catalog").doc("movies");
const snap = await ref.get();
if (!snap.exists || !Array.isArray(snap.data().items)) {
  console.error("Catalog not found.");
  process.exit(1);
}
const items = snap.data().items;
const idx = items.findIndex((m) => m.title === oldTitle);
if (idx === -1) {
  console.error(`"${oldTitle}" not found.`);
  process.exit(1);
}
items[idx].title = newTitle;
await ref.set({ items, updatedAt: new Date().toISOString() });
console.log(`Renamed to "${newTitle}"`);
