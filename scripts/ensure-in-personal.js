/**
 * Ensure a title is in a user's personal list and visible (not in removed).
 * Run: node scripts/ensure-in-personal.js "1941" <uid>
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
  let key;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    key = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, "base64").toString("utf-8"));
  } else {
    key = JSON.parse(readFileSync(keyPath, "utf-8"));
  }
  app = initializeApp({ credential: cert(key) });
} catch (e) {
  console.error("Need serviceAccountKey.json or FIREBASE_SERVICE_ACCOUNT env var");
  process.exit(1);
}

const db = getFirestore(app);

function movieKey(m) {
  return `${m.title || ""}|${m.year ?? ""}`;
}

async function main() {
  const [titleArg, uid] = process.argv.slice(2);
  if (!titleArg || !uid) {
    console.error('Usage: node scripts/ensure-in-personal.js "1941" <uid>');
    console.error("Get UID: node scripts/list-users.js");
    process.exit(1);
  }

  const userSnap = await db.collection("users").doc(uid).get();
  if (!userSnap.exists) {
    console.error("User not found");
    process.exit(1);
  }
  const userData = userSnap.data();
  let userItems = Array.isArray(userData.items) ? [...userData.items] : [];
  let userRemoved = [...(userData.removed || [])];

  const movie = userItems.find((m) => String(m.title || "").trim() === String(titleArg).trim());
  const key = movie ? movieKey(movie) : null;

  if (movie) {
    if (userRemoved.includes(key)) {
      userRemoved = userRemoved.filter((k) => k !== key);
      await db.collection("users").doc(uid).update({ removed: userRemoved });
      console.log(`Restored "${movie.title}" to visible in personal list (was in removed).`);
    } else {
      console.log(`"${movie.title}" already visible in personal list.`);
    }
  } else {
    console.error(`"${titleArg}" not found in user's items. Need to add from shared list or catalog.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
