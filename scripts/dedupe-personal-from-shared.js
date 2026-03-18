/**
 * Remove from each user's personal list any item that exists in "Our list".
 * Keeps items only in the shared list.
 *
 * Run: node scripts/dedupe-personal-from-shared.js
 * Or:  node scripts/dedupe-personal-from-shared.js "Our list"  # list name to match
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
  const listRemoved = new Set(listData.removed || []);
  const sharedKeys = new Set(listItems.filter((m) => !listRemoved.has(movieKey(m))).map((m) => movieKey(m)));

  console.log(`Shared list: ${listData.name} (${listId}) - ${sharedKeys.size} items`);

  const members = listData.members || [];
  if (!members.length) {
    console.log("No members in shared list.");
    return;
  }

  for (const uid of members) {
    const userSnap = await db.collection("users").doc(uid).get();
    if (!userSnap.exists) continue;
    const userData = userSnap.data();
    const userItems = Array.isArray(userData.items) ? userData.items : [];
    const userRemoved = new Set(userData.removed || []);

    const toRemove = [];
    for (const m of userItems) {
      const key = movieKey(m);
      if (userRemoved.has(key)) continue;
      if (sharedKeys.has(key)) toRemove.push(key);
    }

    if (toRemove.length === 0) continue;

    const userRef = db.collection("users").doc(uid);
    await userRef.update({
      watched: FieldValue.arrayRemove(...toRemove),
      maybeLater: FieldValue.arrayRemove(...toRemove),
      archive: FieldValue.arrayRemove(...toRemove),
      removed: FieldValue.arrayUnion(...toRemove),
    });
    console.log(`Removed ${toRemove.length} duplicates from user ${uid}`);
  }
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
