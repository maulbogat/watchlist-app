/**
 * Netlify serverless function: **trigger-upcoming-sync**
 *
 * **Trigger:** HTTP `GET` or `POST` (and `OPTIONS`). Same Firestore work as **`check-upcoming`**
 * (`runUpcomingSyncCore` → `lib/sync-upcoming-alerts.js`).
 *
 * Netlify **scheduled** functions are not reliably invokable via `curl`; use this URL for manual runs:
 *
 *   curl -X POST "https://YOUR-SITE.vercel.app/api/trigger-upcoming-sync"
 *
 * Optional: `UPCOMING_SYNC_TRIGGER_SECRET` — require header `Authorization: Bearer <secret>`.
 *
 * **Firestore writes:** `upcomingAlerts/*`, `syncState/upcomingAlerts` (see `check-upcoming` module doc).
 *
 * @module netlify/functions/trigger-upcoming-sync
 */

/**
 * @typedef {import('../../src/types/index.js').UpcomingAlert} UpcomingAlert
 */

const { getFirestore } = require("firebase-admin/firestore");
const { getAdminApp, runUpcomingSyncCore } = require("../src/api-lib/execute-upcoming-sync");
const { checkFirestoreQuota, QuotaExceededError } = require("../src/api-lib/firestore-guard");

/**
 * @returns {Record<string, string>}
 */
function corsHeaders() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

/**
 * @param {import('@netlify/functions').HandlerEvent} event
 * @param {import('@netlify/functions').HandlerContext} [context]
 * @returns {Promise<import('@netlify/functions').HandlerResponse>}
 */
exports.handler = async (event, context) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders() };
  }

  if (event.httpMethod !== "POST" && event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers: corsHeaders(),
      body: JSON.stringify({ ok: false, error: "Use GET or POST" }),
    };
  }

  const secret = process.env.UPCOMING_SYNC_TRIGGER_SECRET;
  if (secret && String(secret).trim()) {
    const auth = (event.headers?.authorization || event.headers?.Authorization || "").trim();
    if (auth !== `Bearer ${secret.trim()}`) {
      return {
        statusCode: 401,
        headers: corsHeaders(),
        body: JSON.stringify({ ok: false, error: "Unauthorized" }),
      };
    }
  }

  const db = getFirestore(getAdminApp());

  try {
    await checkFirestoreQuota(db, 50);
    const result = await runUpcomingSyncCore(21000);
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ ok: true, ...result }),
    };
  } catch (e) {
    if (e instanceof QuotaExceededError) {
      return {
        statusCode: 503,
        headers: corsHeaders(),
        body: JSON.stringify({ error: "quota_exceeded", period: e.period }),
      };
    }
    console.error("trigger-upcoming-sync:", e);
    const code = e.statusCode || 500;
    return {
      statusCode: code,
      headers: corsHeaders(),
      body: JSON.stringify({ ok: false, error: e.message || String(e) }),
    };
  }
};

const { wrapNetlifyHandler } = require("../src/api-lib/vercel-adapter");
module.exports = wrapNetlifyHandler(exports.handler);
