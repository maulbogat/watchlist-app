/**
 * Remove from "Our list" (shared list) any item that exists in any member's "My list" (personal list).
 * Keeps duplicates only in My list.
 *
 * Run: node scripts/dedupe-shared-from-personal.js
 * Or:  node scripts/dedupe-shared-from-personal.js "Our list"  # list name to match
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
  const listName = process.argv[2] || "Our list";

  const listsSnap = await db.collection("sharedLists").get();
  const match = listsSnap.docs.find((d) => {
    const name = (d.data().name || "").toLowerCase();
    return name.includes(listName.toLowerCase()) || listName.toLowerCase().includes(name);
  });
  if (!match) {
    console.error(`No shared list found matching "${listName}"`);
    process.exit(1);
  }
  const listId = match.id;
  const listData = match.data();
  const listItems = Array.isArray(listData.items) ? listData.items : [];
  const listWatched = new Set(listData.watched || []);
  const listMaybeLater = new Set(listData.maybeLater || []);
  const listArchive = new Set(listData.archive || []);

  const members = listData.members || [];
  if (!members.length) {
    console.log("No members in shared list.");
    return;
  }

  const personalKeys = new Set();
  for (const uid of members) {
    const userSnap = await db.collection("users").doc(uid).get();
    if (!userSnap.exists) continue;
    const userData = userSnap.data();
    const userItems = Array.isArray(userData.items) ? userData.items : [];
    userItems.forEach((m) => personalKeys.add(movieKey(m)));
  }

  const toRemove = [];
  for (const m of listItems) {
    const key = movieKey(m);
    if (personalKeys.has(key)) toRemove.push(key);
  }

  if (toRemove.length === 0) {
    console.log("No duplicates found. All shared list items are unique to the shared list.");
    return;
  }

  const newItems = listItems.filter((m) => !toRemove.includes(movieKey(m)));
  toRemove.forEach((k) => {
    listWatched.delete(k);
    listMaybeLater.delete(k);
    listArchive.delete(k);
  });

  await db.collection("sharedLists").doc(listId).update({
    items: newItems,
    watched: FieldValue.arrayRemove(...toRemove),
    maybeLater: FieldValue.arrayRemove(...toRemove),
    archive: FieldValue.arrayRemove(...toRemove),
  });

  console.log(`Removed ${toRemove.length} duplicates from "${listData.name}" (shared list).`);
  console.log("Kept those items only in My list.");
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
