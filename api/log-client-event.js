/**
 * Authenticated client → Axiom ingest (no `VITE_*` tokens in the browser bundle).
 *
 * POST JSON body: same shape as `src/lib/axiom-logger` events.
 * Header: `Authorization: Bearer <Firebase ID token>`
 */

const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { createFunctionLogger } = require("./lib/logger");

const APP_NAME = "watchlist-admin";

/**
 * @returns {import('firebase-admin/app').App}
 */
function getApp() {
  if (global.__watchlistAdminApp) return global.__watchlistAdminApp;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT not set");
  const key = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
  const app = initializeApp({ credential: cert(key), projectId: key.project_id }, APP_NAME);
  global.__watchlistAdminApp = app;
  return app;
}

/**
 * @param {import('@netlify/functions').HandlerEvent} event
 */
function corsHeaders(event) {
  const origin = event.headers?.origin || event.headers?.Origin || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

const logToAxiom = createFunctionLogger("log-client-event");

/**
 * @param {import('@netlify/functions').HandlerEvent} event
 */
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(event), body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { ...corsHeaders(event), "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: "Method not allowed" }),
    };
  }

  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    return {
      statusCode: 401,
      headers: { ...corsHeaders(event), "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: "Missing Authorization" }),
    };
  }

  let uid;
  try {
    const idToken = authHeader.slice(7);
    uid = (await getAuth(getApp()).verifyIdToken(idToken)).uid;
  } catch {
    return {
      statusCode: 401,
      headers: { ...corsHeaders(event), "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: "Invalid token" }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return {
      statusCode: 400,
      headers: { ...corsHeaders(event), "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: "Invalid JSON" }),
    };
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders(event), "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: "Invalid body" }),
    };
  }

  logToAxiom({
    ...payload,
    verifiedUid: uid,
    source: "client-ingest",
  });

  return { statusCode: 204, headers: corsHeaders(event), body: "" };
};

const { wrapNetlifyHandler } = require("./lib/vercel-adapter");
module.exports = wrapNetlifyHandler(exports.handler);
