/**
 * Search for a title in a shared list.
 * Run: node scripts/search-list.js "247" "Our list"
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const keyPath = join(rootDir, "serviceAccountKey.json");
const key = JSON.parse(readFileSync(keyPath, "utf-8"));
const app = initializeApp({ credential: cert(key) });
const db = getFirestore(app);

const [search, listName] = process.argv.slice(2);
if (!search) {
  console.error('Usage: node scripts/search-list.js "247" "Our list"');
  process.exit(1);
}

const listsSnap = await db.collection("sharedLists").get();
const match = listsSnap.docs.find((d) => (d.data().name || "").toLowerCase().includes((listName || "our").toLowerCase()));
if (!match) {
  console.error("List not found");
  process.exit(1);
}
const items = match.data().items || [];
const s = search.toLowerCase();
const found = items.filter((m) => String(m.title || "").toLowerCase().includes(s));
console.log(`Found ${found.length} matches for "${search}":`);
found.forEach((m) => console.log(`  - ${m.title} (${m.year ?? "—"})`));
