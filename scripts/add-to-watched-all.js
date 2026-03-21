/**
 * Mark a title as watched for every user document.
 * Run: node scripts/add-to-watched-all.js "Alice in Borderland"
 */
import { getDb } from "./lib/admin-init.mjs";
import { loadAllRegistryMap, findByTitle } from "./lib/registry-query.mjs";
import { listKey } from "../lib/registry-id.js";
import { FieldValue } from "firebase-admin/firestore";

const titleArg = process.argv[2] || "Alice in Borderland";

async function main() {
  const db = getDb();
  const regMap = await loadAllRegistryMap(db);
  let hits = findByTitle(regMap, titleArg, { exact: true });
  if (hits.length === 0) hits = findByTitle(regMap, titleArg, { exact: false });
  if (hits.length === 0) {
    console.error(`No titleRegistry match for "${titleArg}".`);
    process.exit(1);
  }
  if (hits.length > 1) {
    console.error("Ambiguous matches:", hits.map((h) => h.title).join(", "));
    process.exit(1);
  }
  const movie = hits[0];
  const key = movie.registryId || listKey(movie);

  const usersSnap = await db.collection("users").get();
  if (usersSnap.empty) {
    console.log("No users in Firestore.");
    process.exit(0);
  }
  for (const doc of usersSnap.docs) {
    await doc.ref.set({ watched: FieldValue.arrayUnion(key) }, { merge: true });
    console.log(`Added "${movie.title}" to watched for user ${doc.id}`);
  }
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
