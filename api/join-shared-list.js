/**
 * Netlify serverless function: **join-shared-list**
 *
 * **Trigger:** HTTP `POST` (and `OPTIONS`). Authenticated user joins a shared list via invite.
 * Token from `bookmarklet_token` cookie or `Authorization: Bearer`.
 *
 * **Firestore writes:**
 * - **`sharedLists/{listId}`** — `update` with `members: arrayUnion(uid)` when the list exists, has a name,
 *   and the user is not already a member.
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
    "Access-Control-Allow-Headers": "Content-Type",
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
  const token = cookies.bookmarklet_token || (event.headers?.authorization || "").replace("Bearer ", "");
  if (!token) {
    return jsonRes(401, { ok: false, error: "Sign in first" }, event);
  }

  let uid;
  try {
    const app = getApp();
    const auth = getAuth(app);
    const decoded = await auth.verifyIdToken(token);
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

  await listRef.update({
    members: FieldValue.arrayUnion(uid),
  });

  return jsonRes(200, { ok: true, joined: true, message: `Joined "${listName}"`, name: listName }, event);
};

const { wrapNetlifyHandler } = require("./lib/vercel-adapter");
module.exports = wrapNetlifyHandler(exports.handler);
