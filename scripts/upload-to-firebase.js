/**
 * One-time script to upload movie catalog from data.js to Firestore.
 * Run: node scripts/upload-to-firebase.js
 *
 * Requires: GOOGLE_APPLICATION_CREDENTIALS env var pointing to your Firebase service account JSON.
 * Or: Create a serviceAccountKey.json in project root (add to .gitignore).
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

// Load data.js and extract movies array (JS object syntax, not JSON)
const dataPath = join(rootDir, "data.js");
const dataContent = readFileSync(dataPath, "utf-8");
const match = dataContent.match(/export const movies = (\[[\s\S]*\]);/);
if (!match) throw new Error("Could not parse movies from data.js");
const movies = new Function("return " + match[1])();

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
