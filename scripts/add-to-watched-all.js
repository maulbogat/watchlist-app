/**
 * Add a movie to watched for all users in Firestore.
 * Run: node scripts/add-to-watched-all.js "Alice in Borderland"
 *
 * If no users exist, sign in to the app and mark any movie first.
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const key = JSON.parse(readFileSync(join(rootDir, "serviceAccountKey.json"), "utf-8"));
const app = initializeApp({ credential: cert(key) });
const db = getFirestore(app);

const title = process.argv[2] || "Alice in Borderland";

const catalogSnap = await db.collection("catalog").doc("movies").get();
if (!catalogSnap.exists || !Array.isArray(catalogSnap.data().items)) {
  console.error("Catalog not found.");
  process.exit(1);
}
const movie = catalogSnap.data().items.find((m) =>
  m.title.toLowerCase().includes(title.toLowerCase())
);
if (!movie) {
  console.error(`"${title}" not found in catalog.`);
  process.exit(1);
}
const movieKey = `${movie.title}|${movie.year ?? ""}`;

const usersSnap = await db.collection("users").get();
if (usersSnap.empty) {
  console.log("No users in Firestore. Sign in to the app and mark any movie as watched first.");
  process.exit(0);
}

for (const doc of usersSnap.docs) {
  await doc.ref.set(
    { watched: FieldValue.arrayUnion(movieKey) },
    { merge: true }
  );
  console.log(`Added "${movie.title}" to watched for user ${doc.id}`);
}
console.log("Done.");
