/**
 * Ensure a title is in a user's personal list.
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
  const userItems = Array.isArray(userData.items) ? userData.items : [];

  const movie = userItems.find((m) => String(m.title || "").trim() === String(titleArg).trim());

  if (movie) {
    console.log(`"${movie.title}" is in personal list.`);
  } else {
    console.error(`"${titleArg}" not found in user's items. Need to add from shared list or catalog.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
