/**
 * GET — Firebase Bearer token. Pending invites created by caller (unused, unexpired).
 */

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { getBearerToken } = require("../src/api-lib/invite-helpers");

const APP_NAME = "watchlist-admin";

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
    "Access-Control-Allow-Methods": "GET, OPTIONS",
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
    if (event.httpMethod !== "GET") {
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

    const db = getFirestore(getApp());
    const snap = await db.collection("invites").where("invitedBy", "==", uid).get();
    const now = Date.now();

    /** @type {Array<Record<string, unknown>>} */
    const invites = [];
    for (const d of snap.docs) {
      const x = d.data() || {};
      if (x.usedAt != null) continue;
      const expiresAt = typeof x.expiresAt === "string" ? Date.parse(x.expiresAt) : 0;
      if (!expiresAt || expiresAt <= now) continue;
      invites.push({
        inviteId: d.id,
        invitedEmail: x.invitedEmail || "",
        listId: x.listId != null ? x.listId : null,
        createdAt: x.createdAt || null,
        expiresAt: x.expiresAt || null,
        usedAt: null,
      });
    }

    invites.sort((a, b) => {
      const ca = String(a.createdAt || "");
      const cb = String(b.createdAt || "");
      return ca < cb ? 1 : ca > cb ? -1 : 0;
    });

    return json(200, { ok: true, invites }, event);
  } catch (e) {
    console.error("get-invites:", e);
    return json(500, { ok: false, error: "internal_error" }, event);
  }
};

const { wrapNetlifyHandler } = require("../src/api-lib/vercel-adapter");
module.exports = wrapNetlifyHandler(exports.handler);
