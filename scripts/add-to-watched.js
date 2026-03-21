/**
 * Mark a title as watched for a user (uses registryId / title|year keys).
 * Run: node scripts/add-to-watched.js <userId> "Movie Title"
 */
import { getDb } from "./lib/admin-init.mjs";
import { loadAllRegistryMap, findByTitle } from "./lib/registry-query.mjs";
import { listKey } from "../lib/registry-id.js";
import { FieldValue } from "firebase-admin/firestore";

async function main() {
  const [, , uid, title] = process.argv;
  if (!uid || !title) {
    console.error('Usage: node scripts/add-to-watched.js <userId> "Movie Title"');
    process.exit(1);
  }
  const db = getDb();
  const regMap = await loadAllRegistryMap(db);
  const hits = findByTitle(regMap, title, { exact: true });
  if (hits.length === 0) {
    const loose = findByTitle(regMap, title, { exact: false });
    if (loose.length === 1) {
      hits.push(loose[0]);
    } else {
      console.error(`No titleRegistry match for "${title}".`);
      process.exit(1);
    }
  }
  if (hits.length > 1) {
    console.error(`Ambiguous title "${title}". Matches:`, hits.map((h) => `${h.title} (${h.year}) ${h.registryId}`).join("; "));
    process.exit(1);
  }
  const movie = hits[0];
  const key = movie.registryId || listKey(movie);
  await db.collection("users").doc(uid).set({ watched: FieldValue.arrayUnion(key) }, { merge: true });
  console.log(`Added "${movie.title}" → watched key ${key} for user ${uid}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
