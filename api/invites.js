/**
 * Unified invite API (single Vercel function):
 * GET  /api/invites — pending invites for caller
 * POST /api/invites { action: "send", invitedEmail, listId? }
 * POST /api/invites { action: "accept", inviteId }
 * DELETE /api/invites { inviteId } — inviter-only revoke
 */

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
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
const logEvent = createFunctionLogger("invites");

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
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
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

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function verifyUid(event) {
  const token = getBearerToken(event);
  if (!token) return { error: json(401, { ok: false, error: "Missing Authorization" }, event) };
  try {
    const uid = (await getAuth(getApp()).verifyIdToken(token)).uid;
    return { uid };
  } catch {
    return { error: json(401, { ok: false, error: "Invalid token" }, event) };
  }
}

async function handleGet(event) {
  const authz = await verifyUid(event);
  if (authz.error) return authz.error;
  const { uid } = authz;

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
}

async function handleSend(event, body) {
  const authz = await verifyUid(event);
  if (authz.error) return authz.error;
  const { uid } = authz;

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
}

async function handleAccept(event, body) {
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
}

async function handleDelete(event, body) {
  const authz = await verifyUid(event);
  if (authz.error) return authz.error;
  const { uid } = authz;

  const inviteId = typeof body.inviteId === "string" ? body.inviteId.trim() : "";
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
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 204, headers: corsHeaders(event), body: "" };
    }

    if (event.httpMethod === "GET") {
      return await handleGet(event);
    }

    if (event.httpMethod === "DELETE") {
      let body = {};
      try {
        const raw = typeof event.body === "string" ? event.body : "";
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return json(400, { ok: false, error: "Invalid JSON" }, event);
      }
      return await handleDelete(event, body);
    }

    if (event.httpMethod === "POST") {
      let body;
      try {
        body = typeof event.body === "string" ? JSON.parse(event.body || "{}") : event.body || {};
      } catch {
        return json(400, { ok: false, error: "Invalid JSON" }, event);
      }

      const action = typeof body.action === "string" ? body.action.trim().toLowerCase() : "";
      if (action === "send") {
        return await handleSend(event, body);
      }
      if (action === "accept") {
        return await handleAccept(event, body);
      }
      return json(400, { ok: false, error: "action required (send or accept)" }, event);
    }

    return json(405, { ok: false, error: "Method not allowed" }, event);
  } catch (e) {
    console.error("invites:", e);
    return json(500, { ok: false, error: "internal_error" }, event);
  }
};

const { wrapNetlifyHandler } = require("../src/api-lib/vercel-adapter");
module.exports = wrapNetlifyHandler(exports.handler);
