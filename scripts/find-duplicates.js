/**
 * Find duplicate titles in Firestore catalog.
 * Run: node scripts/find-duplicates.js
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

const snap = await db.collection("catalog").doc("movies").get();
const items = snap.data().items;
const byKey = {};
items.forEach((m, i) => {
  const k = `${(m.title || "").toLowerCase()}|${m.year ?? ""}`;
  if (!byKey[k]) byKey[k] = [];
  byKey[k].push({ ...m, _idx: i });
});
const dups = Object.entries(byKey).filter(([, v]) => v.length > 1);
if (dups.length) {
  console.log("Duplicates found:");
  dups.forEach(([k, arr]) => console.log(`  ${k}: ${arr.length} copies`));
} else {
  console.log("No duplicates found.");
}
