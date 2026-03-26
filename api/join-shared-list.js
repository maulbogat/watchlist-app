/**
 * Netlify serverless function: **join-shared-list**
 *
 * **Trigger:** HTTP `POST` (and `OPTIONS`). Authenticated user joins a shared list via invite.
 * Token from `bookmarklet_token` cookie or `Authorization: Bearer`.
 *
 * **Firestore writes:**
 * - **`sharedLists/{listId}`** — `update` with `members: arrayUnion(uid)` when the list exists, has a name,
 *   the user is not already a member, and **`invites`** has a pending row for the caller’s email + this **`listId`**
 *   (then that invite is marked **`usedAt` / `usedBy`**).
 *
 * @module netlify/functions/join-shared-list
 */

/**
 * @typedef {import('../../src/types/index.js').SharedList} SharedList
 *
 * POST JSON body.
 * @typedef {{ listId: string }} JoinSharedListBody
 *
 * Success — already a member.
 * @typedef {{ ok: true, joined: false, message: string, name: string }} JoinSharedListAlreadyMember
 *
 * Success — newly joined.
 * @typedef {{ ok: true, joined: true, message: string, name: string }} JoinSharedListJoined
 * @typedef {JoinSharedListAlreadyMember | JoinSharedListJoined} JoinSharedListSuccess
 *
 * @typedef {{ ok: false, error: string }} JoinSharedListError
 */

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { getBearerToken, normalizeInviteEmail } = require("../src/api-lib/invite-helpers");

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
 * @returns {Record<string, string>}
 */
function corsHeaders(event) {
  const origin = event.headers?.origin || event.headers?.Origin || "*";
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

/**
 * @param {number} status
 * @param {JoinSharedListSuccess | JoinSharedListError} body
 * @param {import('@netlify/functions').HandlerEvent} event
 * @returns {import('@netlify/functions').HandlerResponse}
 */
function jsonRes(status, body, event) {
  return {
    statusCode: status,
    headers: corsHeaders(event),
    body: JSON.stringify(body),
  };
}

/**
 * @param {import('@netlify/functions').HandlerEvent} event
 * @param {import('@netlify/functions').HandlerContext} context
 * @returns {Promise<import('@netlify/functions').HandlerResponse>}
 */
exports.handler = async (event, context) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(event) };
  }
  if (event.httpMethod !== "POST") {
    return jsonRes(405, { ok: false, error: "Method not allowed" }, event);
  }

  const cookies = {};
  (event.headers?.cookie || "").split(";").forEach((c) => {
    const [k, v] = c.trim().split("=").map((s) => (s || "").trim());
    if (k && v) cookies[k] = decodeURIComponent(v);
  });
  const bearer = getBearerToken(event);
  const token = bearer || cookies.bookmarklet_token;
  if (!token) {
    return jsonRes(401, { ok: false, error: "Sign in first" }, event);
  }

  let uid;
  /** @type {import('firebase-admin/auth').DecodedIdToken | undefined} */
  let decoded;
  try {
    const app = getApp();
    const auth = getAuth(app);
    decoded = await auth.verifyIdToken(token);
    uid = decoded.uid;
  } catch (e) {
    return jsonRes(401, { ok: false, error: "Invalid or expired token. Sign in again." }, event);
  }

  let body;
  try {
    body = typeof event.body === "string" ? JSON.parse(event.body) : event.body || {};
  } catch (e) {
    return jsonRes(400, { ok: false, error: "Invalid JSON body" }, event);
  }
  const { listId } = body;
  if (!listId || typeof listId !== "string") {
    return jsonRes(400, { ok: false, error: "listId required" }, event);
  }

  const db = getFirestore(getApp());
  const listRef = db.collection("sharedLists").doc(listId);
  const listSnap = await listRef.get();
  if (!listSnap.exists) {
    return jsonRes(404, { ok: false, error: "Shared list not found" }, event);
  }

  const data = listSnap.data();
  const members = Array.isArray(data.members) ? data.members : [];
  const listName = typeof data.name === "string" ? data.name.trim() : "";

  if (members.includes(uid)) {
    return jsonRes(200, { ok: true, joined: false, message: "Already a member", name: listName }, event);
  }

  if (!listName) {
    return jsonRes(
      400,
      {
        ok: false,
        error: "This shared list has no name. The owner must set a name in the app before others can join.",
      },
      event
    );
  }

  const tokenEmail = decoded.email != null ? normalizeInviteEmail(decoded.email) : "";
  if (!tokenEmail) {
    return jsonRes(403, { ok: false, error: "no_email_on_token" }, event);
  }

  const pendingSnap = await db
    .collection("invites")
    .where("invitedEmail", "==", tokenEmail)
    .where("usedAt", "==", null)
    .get();

  const nowMs = Date.now();
  /** @type {import('firebase-admin/firestore').DocumentReference | null} */
  let inviteRefToConsume = null;
  for (const d of pendingSnap.docs) {
    const x = d.data() || {};
    const invList = x.listId != null && String(x.listId).trim() ? String(x.listId).trim() : null;
    if (invList !== listId) continue;
    const ex = typeof x.expiresAt === "string" ? Date.parse(x.expiresAt) : 0;
    if (!ex || ex <= nowMs) continue;
    inviteRefToConsume = d.ref;
    break;
  }

  if (!inviteRefToConsume) {
    return jsonRes(403, { ok: false, error: "invite_required" }, event);
  }

  await listRef.update({
    members: FieldValue.arrayUnion(uid),
  });

  const acceptedAt = new Date().toISOString();
  await inviteRefToConsume.update({
    usedAt: acceptedAt,
    usedBy: uid,
  });

  return jsonRes(200, { ok: true, joined: true, message: `Joined "${listName}"`, name: listName }, event);
};

const { wrapNetlifyHandler } = require("../src/api-lib/vercel-adapter");
module.exports = wrapNetlifyHandler(exports.handler);
