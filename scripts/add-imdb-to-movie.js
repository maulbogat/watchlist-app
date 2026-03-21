/**
 * Set imdbId on a titleRegistry doc (by title + year). If doc id becomes tt*, migrates from legacy id.
 * Run: node scripts/add-imdb-to-movie.js "Runt" 2021 tt6988296
 *
 * Requires: serviceAccountKey.json or FIREBASE_SERVICE_ACCOUNT
 */
import { getDb } from "./lib/admin-init.mjs";
import { loadAllRegistryMap, findByTitle } from "./lib/registry-query.mjs";
import { registryDocIdFromItem, payloadForRegistry, normalizeImdbId } from "../lib/registry-id.js";
import { rewriteRegistryIdEverywhere } from "./lib/rewrite-registry-id.mjs";

function normImdb(id) {
  return normalizeImdbId(id);
}

async function main() {
  const [, , title, year, imdbId] = process.argv;
  if (!title || !year || !imdbId) {
    console.error('Usage: node scripts/add-imdb-to-movie.js "Movie Title" year imdbId');
    process.exit(1);
  }

  const db = getDb();
  const imdb = normImdb(imdbId);
  if (!imdb) {
    console.error("Invalid imdbId");
    process.exit(1);
  }

  const regMap = await loadAllRegistryMap(db);
  const hits = findByTitle(regMap, title, { exact: true, year });
  if (hits.length === 0) {
    console.error(`Movie "${title}" (${year}) not found in titleRegistry.`);
    process.exit(1);
  }
  if (hits.length > 1) {
    console.error("Ambiguous matches:", hits.map((h) => h.registryId).join(", "));
    process.exit(1);
  }

  const cur = hits[0];
  const oldId = cur.registryId;
  if (normalizeImdbId(cur.imdbId) === imdb) {
    console.log(`titleRegistry/${oldId} already has imdbId ${imdb}.`);
    return;
  }

  const snap = await db.collection("titleRegistry").get();
  for (const d of snap.docs) {
    if (d.id === oldId) continue;
    if (normalizeImdbId(d.data().imdbId) === imdb) {
      console.error(`Another doc ${d.id} already has imdbId ${imdb}.`);
      process.exit(1);
    }
  }
  const merged = { ...cur, imdbId: imdb };
  const newId = registryDocIdFromItem(merged);
  const payload = payloadForRegistry({ ...merged, registryId: newId });

  if (newId === oldId) {
    await db.collection("titleRegistry").doc(oldId).set({ imdbId: imdb }, { merge: true });
    console.log(`Set imdbId ${imdb} on titleRegistry/${oldId}`);
  } else {
    await db.collection("titleRegistry").doc(newId).set(payload, { merge: true });
    await rewriteRegistryIdEverywhere(db, oldId, newId);
    await db.collection("titleRegistry").doc(oldId).delete();
    console.log(`Migrated ${oldId} → ${newId} with imdbId ${imdb}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
