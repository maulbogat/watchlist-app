/**
 * POST { invitedEmail, listId? } — Firebase Bearer token. Sends app invite email (Resend).
 */

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { randomUUID } = require("crypto");
const { createFunctionLogger } = require("../src/api-lib/logger");
const { sendResendEmail } = require("../src/api-lib/resend-send");
const {
  normalizeInviteEmail,
  isValidEmailFormat,
  maskEmailForLog,
  getBearerToken,
} = require("../src/api-lib/invite-helpers");

const APP_NAME = "watchlist-admin";
const logEvent = createFunctionLogger("send-invite");

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

    let uid;
    try {
      uid = (await getAuth(getApp()).verifyIdToken(token)).uid;
    } catch {
      return json(401, { ok: false, error: "Invalid token" }, event);
    }

    let body;
    try {
      body = typeof event.body === "string" ? JSON.parse(event.body || "{}") : event.body || {};
    } catch {
      return json(400, { ok: false, error: "Invalid JSON" }, event);
    }

    const invitedEmail = normalizeInviteEmail(body.invitedEmail);
    if (!isValidEmailFormat(invitedEmail)) {
      return json(400, { ok: false, error: "invalid_email" }, event);
    }

    const listIdRaw = body.listId != null && String(body.listId).trim() ? String(body.listId).trim() : null;

    const db = getFirestore(getApp());
    const allowedRef = db.collection("allowedUsers").doc(invitedEmail);
    const allowedSnap = await allowedRef.get();
    if (allowedSnap.exists) {
      logEvent({ type: "invite.send.skip", reason: "already_allowed", emailMasked: maskEmailForLog(invitedEmail) });
      return json(409, { ok: false, error: "user_already_allowed" }, event);
    }

    const pendingSnap = await db.collection("invites").where("invitedEmail", "==", invitedEmail).where("usedAt", "==", null).get();

    const nowMs = Date.now();
    for (const d of pendingSnap.docs) {
      const ex = d.data()?.expiresAt;
      if (typeof ex === "string" && Date.parse(ex) > nowMs) {
        logEvent({ type: "invite.send.skip", reason: "pending_exists", emailMasked: maskEmailForLog(invitedEmail) });
        return json(409, { ok: false, error: "invite_pending" }, event);
      }
    }

    if (listIdRaw) {
      const listRef = db.collection("sharedLists").doc(listIdRaw);
      const listSnap = await listRef.get();
      if (!listSnap.exists) {
        return json(404, { ok: false, error: "list_not_found" }, event);
      }
      const members = Array.isArray(listSnap.data()?.members) ? listSnap.data().members : [];
      if (!members.includes(uid)) {
        return json(403, { ok: false, error: "not_list_member" }, event);
      }
    }

    const inviteId = randomUUID();
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(nowMs + 7 * 864e5).toISOString();

    let listName = "";
    if (listIdRaw) {
      const ls = await db.collection("sharedLists").doc(listIdRaw).get();
      listName = typeof ls.data()?.name === "string" ? ls.data().name.trim() : "";
    }

    const baseUrl = (process.env.APP_PUBLIC_URL || "https://movie-trailer-site.vercel.app").replace(/\/$/, "");
    const joinUrl = `${baseUrl}/join-app/${inviteId}`;

    const textLines = [
      "You've been invited to My Watchlist.",
      "",
      `Open this link to sign in and accept: ${joinUrl}`,
      "",
      listIdRaw && listName
        ? `You've also been invited to join the shared list: ${listName}`
        : listIdRaw
          ? "You've also been invited to join a shared list on the app."
          : "",
      "",
      "This link expires in 7 days.",
    ].filter(Boolean);

    const htmlListExtra =
      listIdRaw && listName
        ? `<p>You've also been invited to join the list: <strong>${escapeHtml(listName)}</strong></p>`
        : listIdRaw
          ? "<p>You've also been invited to join a shared list.</p>"
          : "";

    const html = `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111">
<p>You've been invited to <strong>My Watchlist</strong>.</p>
<p><a href="${escapeHtml(joinUrl)}">Accept your invitation</a></p>
${htmlListExtra}
<p style="color:#666;font-size:14px">This link expires in 7 days.</p>
</body></html>`;

    const sendResult = await sendResendEmail({
      to: invitedEmail,
      subject: "You've been invited to My Watchlist",
      text: textLines.join("\n"),
      html,
    });
    if (!sendResult.ok) {
      logEvent({
        type: "invite.send.fail",
        reason: "resend",
        emailMasked: maskEmailForLog(invitedEmail),
        error: sendResult.error,
      });
      return json(502, { ok: false, error: "email_send_failed" }, event);
    }

    await db
      .collection("invites")
      .doc(inviteId)
      .set({
        invitedEmail,
        invitedBy: uid,
        listId: listIdRaw,
        createdAt,
        expiresAt,
        usedAt: null,
        usedBy: null,
      });

    logEvent({ type: "invite.send.ok", emailMasked: maskEmailForLog(invitedEmail), inviteId });
    return json(200, { ok: true, inviteId }, event);
  } catch (e) {
    console.error("send-invite:", e);
    return json(500, { ok: false, error: "internal_error" }, event);
  }
};

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const { wrapNetlifyHandler } = require("../src/api-lib/vercel-adapter");
module.exports = wrapNetlifyHandler(exports.handler);
