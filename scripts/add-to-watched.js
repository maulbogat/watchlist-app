/**
 * Add a movie to a user's watched list in Firestore.
 * Run: node scripts/add-to-watched.js <userId> "A Man on the Inside"
 *
 * Get userId from Firebase Console → Authentication → Users (copy UID).
 * Requires: serviceAccountKey.json in project root.
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const keyPath = join(rootDir, "serviceAccountKey.json");

let app;
try {
  const key = JSON.parse(readFileSync(keyPath, "utf-8"));
  app = initializeApp({ credential: cert(key) });
} catch (e) {
  console.error("Create serviceAccountKey.json in project root.");
  process.exit(1);
}

const db = getFirestore(app);

async function addToWatched(uid, title) {
  const catalogSnap = await db.collection("catalog").doc("movies").get();
  if (!catalogSnap.exists || !Array.isArray(catalogSnap.data().items)) {
    console.error("Catalog not found.");
    process.exit(1);
  }
  const items = catalogSnap.data().items;
  const movie = items.find((m) => m.title.toLowerCase() === title.toLowerCase());
  if (!movie) {
    console.error(`Movie "${title}" not found.`);
    process.exit(1);
  }
  const key = `${movie.title}|${movie.year ?? ""}`;
  const userRef = db.collection("users").doc(uid);
  await userRef.set(
    { watched: FieldValue.arrayUnion(key) },
    { merge: true }
  );
  console.log(`Added "${movie.title}" to watched for user ${uid}`);
}

const [, , uid, title] = process.argv;
if (!uid || !title) {
  console.error(
    'Usage: node scripts/add-to-watched.js <userId> "Movie Title"'
  );
  console.error("Get userId from Firebase Console → Authentication → Users");
  process.exit(1);
}

addToWatched(uid, title).catch((err) => {
  console.error(err);
  process.exit(1);
});
