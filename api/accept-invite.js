/**
 * POST { inviteId } — Firebase Bearer token. Adds user to allowedUsers (+ optional shared list).
 */

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { createFunctionLogger } = require("../src/api-lib/logger");
const { normalizeInviteEmail, maskEmailForLog, getBearerToken } = require("../src/api-lib/invite-helpers");

const APP_NAME = "watchlist-admin";
const logEvent = createFunctionLogger("accept-invite");

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
    "Access-Control-Allow-Methods": "POST, OPTIONS",
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
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method not allowed" }, event);
    }

    const token = getBearerToken(event);
    if (!token) {
      return json(401, { ok: false, error: "Missing Authorization" }, event);
    }

    let decoded;
    try {
      decoded = await getAuth(getApp()).verifyIdToken(token);
    } catch {
      return json(401, { ok: false, error: "Invalid token" }, event);
    }

    const uid = decoded.uid;
    const tokenEmail = decoded.email != null ? normalizeInviteEmail(decoded.email) : "";
    if (!tokenEmail) {
      return json(403, { ok: false, error: "no_email_on_token" }, event);
    }

    let body;
    try {
      body = typeof event.body === "string" ? JSON.parse(event.body || "{}") : event.body || {};
    } catch {
      return json(400, { ok: false, error: "Invalid JSON" }, event);
    }

    const inviteId = typeof body.inviteId === "string" ? body.inviteId.trim() : "";
    if (!inviteId) {
      return json(400, { ok: false, error: "inviteId required" }, event);
    }

    const db = getFirestore(getApp());
    const inviteRef = db.collection("invites").doc(inviteId);
    const inviteSnap = await inviteRef.get();
    if (!inviteSnap.exists) {
      return json(404, { ok: false, error: "not_found" }, event);
    }

    const inv = inviteSnap.data() || {};
    if (inv.usedAt != null) {
      return json(400, { ok: false, error: "already_used" }, event);
    }

    const expiresAt = typeof inv.expiresAt === "string" ? Date.parse(inv.expiresAt) : 0;
    if (!expiresAt || expiresAt < Date.now()) {
      return json(400, { ok: false, error: "expired" }, event);
    }

    const invitedEmail = normalizeInviteEmail(inv.invitedEmail);
    if (!invitedEmail || invitedEmail !== tokenEmail) {
      logEvent({
        type: "invite.accept.fail",
        reason: "email_mismatch",
        emailMasked: maskEmailForLog(tokenEmail),
      });
      return json(403, { ok: false, error: "wrong_email" }, event);
    }

    const invitedBy = typeof inv.invitedBy === "string" ? inv.invitedBy.trim() : "";
    const createdAt = typeof inv.createdAt === "string" ? inv.createdAt : new Date().toISOString();
    const listId = inv.listId != null && String(inv.listId).trim() ? String(inv.listId).trim() : null;

    const acceptedAt = new Date().toISOString();
    const allowedRef = db.collection("allowedUsers").doc(invitedEmail);
    await allowedRef.set({
      uid,
      invitedBy: invitedBy || null,
      invitedAt: createdAt,
      acceptedAt,
    });

    if (listId) {
      const listRef = db.collection("sharedLists").doc(listId);
      const listSnap = await listRef.get();
      if (!listSnap.exists) {
        await inviteRef.update({ usedAt: acceptedAt, usedBy: uid });
        logEvent({ type: "invite.accept.partial", reason: "list_missing", inviteId });
        return json(200, { ok: true, listId: null, warning: "list_not_found" }, event);
      }
      const data = listSnap.data();
      const members = Array.isArray(data.members) ? data.members : [];
      const listName = typeof data.name === "string" ? data.name.trim() : "";
      if (!listName) {
        await inviteRef.update({ usedAt: acceptedAt, usedBy: uid });
        return json(200, { ok: true, listId, warning: "list_unnamed" }, event);
      }
      if (!members.includes(uid)) {
        await listRef.update({
          members: FieldValue.arrayUnion(uid),
        });
      }
    }

    await inviteRef.update({
      usedAt: acceptedAt,
      usedBy: uid,
    });

    logEvent({ type: "invite.accept.ok", emailMasked: maskEmailForLog(invitedEmail), inviteId });
    return json(200, { ok: true, listId: listId || null }, event);
  } catch (e) {
    console.error("accept-invite:", e);
    return json(500, { ok: false, error: "internal_error" }, event);
  }
};

const { wrapNetlifyHandler } = require("../src/api-lib/vercel-adapter");
module.exports = wrapNetlifyHandler(exports.handler);
