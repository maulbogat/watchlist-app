/**
 * DELETE ?inviteId= — Firebase Bearer token. Inviter-only.
 */

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { createFunctionLogger } = require("../src/api-lib/logger");
const { maskEmailForLog, getBearerToken } = require("../src/api-lib/invite-helpers");

const APP_NAME = "watchlist-admin";
const logEvent = createFunctionLogger("revoke-invite");

function getApp() {
  if (global.__watchlistAdminApp) return global.__watchlistAdminApp;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT not set");
  const key = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
  const app = initializeApp({ credential: cert(key), projectId: key.project_id }, APP_NAME);
  global.__watchlistAdminApp = app;
  return app;
}

function corsHeaders(event) {
  const origin = event.headers?.origin || event.headers?.Origin || "*";
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function json(status, body, event) {
  return {
    statusCode: status,
    headers: { ...corsHeaders(event), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 204, headers: corsHeaders(event), body: "" };
    }
    if (event.httpMethod !== "DELETE") {
      return json(405, { ok: false, error: "Method not allowed" }, event);
    }

    const token = getBearerToken(event);
    if (!token) {
      return json(401, { ok: false, error: "Missing Authorization" }, event);
    }

    let uid;
    try {
      uid = (await getAuth(getApp()).verifyIdToken(token)).uid;
    } catch {
      return json(401, { ok: false, error: "Invalid token" }, event);
    }

    const q = event.queryStringParameters || {};
    const inviteId = typeof q.inviteId === "string" ? q.inviteId.trim() : "";
    if (!inviteId) {
      return json(400, { ok: false, error: "inviteId required" }, event);
    }

    const db = getFirestore(getApp());
    const ref = db.collection("invites").doc(inviteId);
    const snap = await ref.get();
    if (!snap.exists) {
      return json(404, { ok: false, error: "not_found" }, event);
    }
    const inv = snap.data() || {};
    if (inv.invitedBy !== uid) {
      return json(403, { ok: false, error: "forbidden" }, event);
    }

    await ref.delete();
    logEvent({
      type: "invite.revoke.ok",
      inviteId,
      emailMasked: maskEmailForLog(inv.invitedEmail),
    });
    return json(200, { ok: true }, event);
  } catch (e) {
    console.error("revoke-invite:", e);
    return json(500, { ok: false, error: "internal_error" }, event);
  }
};

const { wrapNetlifyHandler } = require("../src/api-lib/vercel-adapter");
module.exports = wrapNetlifyHandler(exports.handler);
