/**
 * Shared Firebase Admin init for Node scripts (ESM).
 */
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const scriptsRootDir = join(__dirname, "..", "..");
const keyPath = join(scriptsRootDir, "serviceAccountKey.json");

export function getDb() {
  if (getApps().length > 0) return getFirestore();
  let key;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    key = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, "base64").toString("utf-8"));
  } else if (existsSync(keyPath)) {
    key = JSON.parse(readFileSync(keyPath, "utf-8"));
  } else {
    throw new Error("Need FIREBASE_SERVICE_ACCOUNT (base64) or serviceAccountKey.json in project root.");
  }
  initializeApp({ credential: cert(key) });
  return getFirestore();
}
