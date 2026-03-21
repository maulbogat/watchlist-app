/**
 * Shared Firebase Admin + runRegistrySyncWithTimeBudget for scheduled and HTTP-triggered functions.
 */

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { runRegistrySyncWithTimeBudget } = require("./sync-upcoming-alerts");

function getAdminApp() {
  if (global.__fbAdmin) return global.__fbAdmin;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT not set");
  const key = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
  const app = initializeApp({ credential: cert(key) });
  global.__fbAdmin = app;
  return app;
}

/** @param {number} [budgetMs] */
async function runUpcomingSyncCore(budgetMs = 20000) {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey || !String(apiKey).trim()) {
    const err = new Error("TMDB_API_KEY missing");
    err.statusCode = 500;
    throw err;
  }
  const db = getFirestore(getAdminApp());
  return runRegistrySyncWithTimeBudget(db, apiKey, budgetMs);
}

module.exports = { getAdminApp, runUpcomingSyncCore };
