/**
 * Upload movie catalog from data.json to Firestore.
 * Run: node scripts/upload-to-firebase.js
 *
 * Requires: serviceAccountKey.json in project root (add to .gitignore).
 * Download from: Firebase Console → Project Settings → Service Accounts → Generate new private key
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

const dataPath = join(rootDir, "data.json");
const movies = JSON.parse(readFileSync(dataPath, "utf-8"));

// Initialize Firebase Admin
const keyPath = join(rootDir, "serviceAccountKey.json");
let app;
try {
  const key = JSON.parse(readFileSync(keyPath, "utf-8"));
  app = initializeApp({ credential: cert(key) });
} catch (e) {
  console.error(
    "Create serviceAccountKey.json in project root with your Firebase service account credentials.\n" +
      "Download from: Firebase Console → Project Settings → Service Accounts → Generate new private key"
  );
  process.exit(1);
}

const db = getFirestore(app);

async function upload() {
  const ref = db.collection("catalog").doc("movies");
  await ref.set({ items: movies, updatedAt: new Date().toISOString() });
  console.log(`Uploaded ${movies.length} movies to Firestore catalog/movies`);
}

upload().catch((err) => {
  console.error(err);
  process.exit(1);
});
