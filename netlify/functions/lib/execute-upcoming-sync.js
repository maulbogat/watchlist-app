/**
 * Shared Firebase Admin bootstrap and **`runUpcomingSyncCore`** entry used by
 * `check-upcoming` and `trigger-upcoming-sync`.
 *
 * **Firestore:** read/write is delegated to `sync-upcoming-alerts.js` (`titleRegistry`, `upcomingAlerts`, `syncState`).
 *
 * @module netlify/functions/lib/execute-upcoming-sync
 */

/**
 * @typedef {import('../../../src/types/index.js').UpcomingAlert} UpcomingAlert
 */

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { runRegistrySyncWithTimeBudget } = require("./sync-upcoming-alerts");

const APP_NAME = "watchlist-admin";

/**
 * @returns {import('firebase-admin/app').App}
 */
function getAdminApp() {
  if (global.__watchlistAdminApp) return global.__watchlistAdminApp;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT not set");
  const key = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
  const app = initializeApp({ credential: cert(key), projectId: key.project_id }, APP_NAME);
  global.__watchlistAdminApp = app;
  return app;
}

/**
 * Validates `TMDB_API_KEY`, obtains Firestore, and runs **`runRegistrySyncWithTimeBudget`**.
 *
 * @param {number} [budgetMs] - Max wall-clock ms for a single invocation (Netlify ~30s limit).
 * @returns {Promise<Record<string, unknown>>} Result payload from `runRegistrySyncWithTimeBudget` (counts, `completed`, etc.)
 */
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
