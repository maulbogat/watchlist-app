/**
 * Scheduled: daily TMDB sync → Firestore upcomingAlerts (titleRegistry ∪ catalog/movies).
 * Netlify cron 3:00 UTC. Requires TMDB_API_KEY + FIREBASE_SERVICE_ACCOUNT.
 */

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { runFullRegistrySync } = require("./lib/sync-upcoming-alerts");

function getApp() {
  if (global.__fbAdmin) return global.__fbAdmin;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT not set");
  const key = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
  const app = initializeApp({ credential: cert(key) });
  global.__fbAdmin = app;
  return app;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Access-Control-Allow-Origin": "*" } };
  }

  try {
    const apiKey = process.env.TMDB_API_KEY;
    if (!apiKey || !String(apiKey).trim()) {
      return { statusCode: 500, body: JSON.stringify({ ok: false, error: "TMDB_API_KEY missing" }) };
    }

    const app = getApp();
    const db = getFirestore(app);

    const result = await runFullRegistrySync(db, apiKey);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, ...result }),
    };
  } catch (e) {
    console.error("check-upcoming:", e);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: e.message || String(e) }),
    };
  }
};
