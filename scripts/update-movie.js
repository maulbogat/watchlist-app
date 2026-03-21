/**
 * Update youtubeId (and thumb) for a title in titleRegistry.
 * Run: node scripts/update-movie.js "Man on the Inside" xhsVj_4ONoA
 * Clear trailer thumb: pass null (literal) as second arg.
 *
 * Requires: serviceAccountKey.json or FIREBASE_SERVICE_ACCOUNT
 */
import { getDb } from "./lib/admin-init.mjs";
import { loadAllRegistryMap, findByTitle } from "./lib/registry-query.mjs";

async function updateMovie(title, youtubeId) {
  const db = getDb();
  const regMap = await loadAllRegistryMap(db);
  let hits = findByTitle(regMap, title, { exact: true });
  if (hits.length === 0) hits = findByTitle(regMap, title, { exact: false });
  if (hits.length === 0) {
    console.error(`Movie "${title}" not found in titleRegistry.`);
    process.exit(1);
  }
  if (hits.length > 1) {
    console.error("Ambiguous title. Matches:", hits.map((h) => `${h.title} (${h.year}) ${h.registryId}`).join("; "));
    process.exit(1);
  }
  const m = hits[0];
  const rid = m.registryId;
  const yt = youtubeId === "null" || youtubeId === "" ? null : youtubeId;
  const patch = { youtubeId: yt };
  if (!yt) {
    patch.thumb = null;
  } else {
    patch.thumb = `https://img.youtube.com/vi/${yt}/hqdefault.jpg`;
  }
  await db.collection("titleRegistry").doc(rid).set(patch, { merge: true });
  console.log(`Updated titleRegistry/${rid} "${m.title}" youtubeId → ${yt === null ? "null" : yt}`);
}

const [, , title, rawYoutube] = process.argv;
if (!title || rawYoutube === undefined) {
  console.error('Usage: node scripts/update-movie.js "Movie Title" <youtubeId|null>');
  process.exit(1);
}

updateMovie(title, rawYoutube).catch((err) => {
  console.error(err);
  process.exit(1);
});
