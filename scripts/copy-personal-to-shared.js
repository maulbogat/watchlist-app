/**
 * Copy all items from a user's personal list to a shared list.
 * Does NOT remove from personal list.
 *
 * Run: node scripts/copy-personal-to-shared.js <uid> <listId>
 * Or:  node scripts/copy-personal-to-shared.js <uid> "Our list"  # finds by name
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

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
  const [uid, listIdOrName] = process.argv.slice(2);
  if (!uid || !listIdOrName) {
    console.error("Usage: node scripts/copy-personal-to-shared.js <uid> <listId|listName>");
    process.exit(1);
  }

  let listId = listIdOrName;
  if (listIdOrName.length > 20 || listIdOrName.includes(" ")) {
    const listsSnap = await db.collection("sharedLists").get();
    const match = listsSnap.docs.find((d) => {
      const name = (d.data().name || "").toLowerCase();
      const search = listIdOrName.toLowerCase();
      return name.includes(search) || search.includes(name);
    });
    if (!match) {
      console.error(`No shared list found matching "${listIdOrName}"`);
      process.exit(1);
    }
    listId = match.id;
    console.log(`Found list: ${match.data().name} (${listId})`);
  }

  const userSnap = await db.collection("users").doc(uid).get();
  if (!userSnap.exists) {
    console.error("User not found");
    process.exit(1);
  }
  const userData = userSnap.data();
  const userItems = Array.isArray(userData.items) ? userData.items : [];
  const userRemoved = new Set(userData.removed || []);
  const userWatched = new Set(userData.watched || []);
  const userMaybeLater = new Set(userData.maybeLater || []);
  const userArchive = new Set(userData.archive || []);

  const toCopy = userItems.filter((m) => !userRemoved.has(movieKey(m)));
  if (toCopy.length === 0) {
    console.error("User list is empty");
    process.exit(1);
  }

  const listSnap = await db.collection("sharedLists").doc(listId).get();
  if (!listSnap.exists) {
    console.error("Shared list not found");
    process.exit(1);
  }
  const listData = listSnap.data();
  const members = listData.members || [];
  if (!members.includes(uid)) {
    console.error("User is not a member of this shared list");
    process.exit(1);
  }

  const listItems = Array.isArray(listData.items) ? [...listData.items] : [];
  const listWatched = new Set(listData.watched || []);
  const listMaybeLater = new Set(listData.maybeLater || []);
  const listArchive = new Set(listData.archive || []);
  const listRemoved = new Set(listData.removed || []);
  const existingKeys = new Set(listItems.map((m) => movieKey(m)));

  let added = 0;
  for (const m of toCopy) {
    const key = movieKey(m);
    if (existingKeys.has(key)) continue;
    const { status, removed, ...movie } = m;
    listItems.push(movie);
    existingKeys.add(key);
    listRemoved.delete(key);
    if (userWatched.has(key)) listWatched.add(key);
    else if (userMaybeLater.has(key)) listMaybeLater.add(key);
    else if (userArchive.has(key)) listArchive.add(key);
    added++;
  }

  await db.collection("sharedLists").doc(listId).set(
    {
      items: listItems,
      watched: [...listWatched],
      maybeLater: [...listMaybeLater],
      archive: [...listArchive],
      removed: [...listRemoved],
    },
    { merge: true }
  );

  console.log(`Copied ${added} items to shared list. Personal list unchanged.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
