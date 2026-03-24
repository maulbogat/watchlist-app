/**
 * Looks up a Firebase Auth user by UID and creates/updates `users/{uid}` with `displayName`
 * (same shape the watchlist app expects for shared-list “added by” labels).
 *
 * Run:
 *   node scripts/sync-user-doc-from-auth.js <uid>
 *
 * Requires: `serviceAccountKey.json` at repo root (Admin SDK).
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

const uid = process.argv[2]?.trim();
if (!uid) {
  console.error("Usage: node scripts/sync-user-doc-from-auth.js <firebaseAuthUid>");
  process.exit(1);
}

const key = JSON.parse(readFileSync(join(rootDir, "serviceAccountKey.json"), "utf-8"));
const app = initializeApp({ credential: cert(key) });
const auth = getAuth(app);
const db = getFirestore(app);

let user;
try {
  user = await auth.getUser(uid);
} catch (e) {
  console.error("Auth lookup failed:", e?.message || e);
  process.exit(1);
}

const displayName =
  (user.displayName && String(user.displayName).trim()) ||
  (user.email ? String(user.email).split("@")[0] : "") ||
  "";

console.log("UID:", user.uid);
console.log("Email:", user.email || "(none)");
console.log("Display name (Auth):", user.displayName || "(none)");
console.log("Stored displayName:", displayName || "(empty — not writing)");

if (displayName) {
  await db.collection("users").doc(uid).set({ displayName }, { merge: true });
  console.log(`Wrote users/${uid}.displayName = "${displayName}"`);
} else {
  console.log("Skipped Firestore write (no displayName or email local part).");
}
