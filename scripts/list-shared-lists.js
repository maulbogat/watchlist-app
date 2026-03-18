/**
 * List shared lists in Firestore.
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const key = JSON.parse(readFileSync(join(rootDir, "serviceAccountKey.json"), "utf-8"));
const app = initializeApp({ credential: cert(key) });
const db = getFirestore(app);

const snap = await db.collection("sharedLists").get();
snap.docs.forEach((d) => {
  const data = d.data();
  const count = (data.items || []).length;
  console.log(`${d.id} | ${data.name || "(no name)"} | ${count} items`);
});
