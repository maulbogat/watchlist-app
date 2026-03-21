/**
 * Add a title to titleRegistry (canonical store). Does not add to a user list.
 * Run: node scripts/add-movie.js "Title" [year] [type] [youtubeId] [imdbId]
 *
 * Requires: serviceAccountKey.json or FIREBASE_SERVICE_ACCOUNT
 */
import { getDb } from "./lib/admin-init.mjs";
import { registryDocIdFromItem, payloadForRegistry } from "../lib/registry-id.js";

async function main() {
  const [, , title, year, type, youtubeId, imdbId] = process.argv;
  if (!title) {
    console.error('Usage: node scripts/add-movie.js "Title" [year] [type] [youtubeId] [imdbId]');
    process.exit(1);
  }
  const db = getDb();
  const yt =
    youtubeId && String(youtubeId).trim() !== "" && youtubeId !== "null"
      ? String(youtubeId).trim()
      : null;
  const movie = {
    title,
    year: year ? Number(year) : null,
    type: type === "show" ? "show" : "movie",
    genre: "Comedy / Drama",
    youtubeId: yt,
    services: [],
  };
  if (yt) movie.thumb = `https://img.youtube.com/vi/${yt}/hqdefault.jpg`;
  if (imdbId) movie.imdbId = imdbId.startsWith("tt") ? imdbId : `tt${imdbId}`;

  const rid = registryDocIdFromItem(movie);
  const ref = db.collection("titleRegistry").doc(rid);
  const snap = await ref.get();
  if (snap.exists) {
    console.error(`Already in titleRegistry as ${rid} (“${snap.data()?.title || title}”).`);
    process.exit(1);
  }
  const payload = payloadForRegistry({ ...movie, registryId: rid });
  await ref.set(payload, { merge: true });
  console.log(`Added titleRegistry/${rid} — "${title}" (${year || "—"})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
