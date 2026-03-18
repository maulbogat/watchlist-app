/**
 * Move an item from a shared list to a user's personal list.
 *
 * Run: node scripts/move-from-shared-to-personal.js "1941" "Our list"
 * Or:  node scripts/move-from-shared-to-personal.js "1941" "Our list" <uid>
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
  const [titleArg, listIdOrName] = process.argv.slice(2);
  if (!titleArg || !listIdOrName) {
    console.error('Usage: node scripts/move-from-shared-to-personal.js "1941" "Our list"');
    process.exit(1);
  }

  let listId = listIdOrName;
  if (listIdOrName.length > 20 || listIdOrName.includes(" ")) {
    const listsSnap = await db.collection("sharedLists").get();
    const match = listsSnap.docs.find((d) => {
      const name = (d.data().name || "").toLowerCase();
      return name.includes(listIdOrName.toLowerCase()) || listIdOrName.toLowerCase().includes(name);
    });
    if (!match) {
      console.error(`No shared list found matching "${listIdOrName}"`);
      process.exit(1);
    }
    listId = match.id;
    console.log(`Found list: ${match.data().name} (${listId})`);
  }

  const listSnap = await db.collection("sharedLists").doc(listId).get();
  if (!listSnap.exists) {
    console.error("Shared list not found");
    process.exit(1);
  }
  const listData = listSnap.data();
  const listItems = Array.isArray(listData.items) ? [...listData.items] : [];
  const listRemoved = new Set(listData.removed || []);

  const movie = listItems.find((m) => {
    const titleMatch = String(m.title || "").trim() === String(titleArg).trim();
    return titleMatch;
  });

  if (!movie) {
    console.error(`"${titleArg}" not found in shared list`);
    process.exit(1);
  }

  const key = movieKey(movie);
  const members = listData.members || [];
  const uid = process.argv[4] || members[0];
  if (!uid) {
    console.error("No members in shared list. Pass UID: node scripts/move-from-shared-to-personal.js \"1941\" \"Our list\" <uid>");
    process.exit(1);
  }
  if (!members.includes(uid)) {
    console.error("UID is not a member of this shared list");
    process.exit(1);
  }

  const userSnap = await db.collection("users").doc(uid).get();
  if (!userSnap.exists) {
    console.error("User not found");
    process.exit(1);
  }
  const userData = userSnap.data();
  const userItems = Array.isArray(userData.items) ? [...userData.items] : [];
  const userRemoved = new Set(userData.removed || []);
  const existingKeys = new Set(userItems.map((m) => movieKey(m)));
  const userUpdate = {};

  if (existingKeys.has(key)) {
    console.log(`"${movie.title}" already in personal list. Removing from shared list only.`);
  } else {
    const { status, removed, ...movieClean } = movie;
    userItems.push(movieClean);
    userUpdate.items = userItems;
    console.log(`Added "${movie.title}" to personal list.`);
  }

  if (userRemoved.has(key)) {
    userUpdate.removed = FieldValue.arrayRemove(key);
    console.log(`Restored "${movie.title}" to visible (was in removed).`);
  }

  if (Object.keys(userUpdate).length) {
    await db.collection("users").doc(uid).update(userUpdate);
  }

  await db.collection("sharedLists").doc(listId).update({
    watched: FieldValue.arrayRemove(key),
    maybeLater: FieldValue.arrayRemove(key),
    archive: FieldValue.arrayRemove(key),
    removed: FieldValue.arrayUnion(key),
  });
  console.log(`Removed "${movie.title}" from shared list.`);
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
