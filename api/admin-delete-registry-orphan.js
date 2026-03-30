/**
 * Admin-only: delete a `titleRegistry` document that is still not referenced on any list.
 * POST body: `{ "registryId": "<doc id>" }`
 * Requires `Authorization: Bearer <Firebase ID token>` and an admin UID.
 *
 * Refuses deletion if `registryId` appears on any list row (re-scan at request time).
 *
 * Env: `FIREBASE_SERVICE_ACCOUNT`
 */

const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { getAdminApp } = require("../src/api-lib/execute-upcoming-sync");
const { ADMIN_UIDS } = require("../src/api-lib/admin-uids");
const { scanReferencedRegistryIds } = require("../src/api-lib/catalog-orphan-scan.cjs");

const MAX_REGISTRY_ID_LEN = 512;

function corsHeaders() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: corsHeaders(),
    body: JSON.stringify(body),
  };
}

function normalizeRegistryId(raw) {
  if (raw == null) return "";
  const s = String(raw).trim();
  if (!s || s.length > MAX_REGISTRY_ID_LEN) return "";
  if (s.includes("/") || s.includes("..")) return "";
  return s;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders() };
  }
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" });
  }

  const authHeader = (event.headers && (event.headers.authorization || event.headers.Authorization)) || "";
  const idToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!idToken) {
    return json(401, { ok: false, error: "Authorization required" });
  }

  let uid;
  try {
    const decoded = await getAuth(getAdminApp()).verifyIdToken(idToken);
    uid = decoded.uid;
  } catch {
    return json(401, { ok: false, error: "Invalid or expired token" });
  }
  if (!ADMIN_UIDS.has(uid)) {
    return json(403, { ok: false, error: "Forbidden" });
  }

  let body;
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { ok: false, error: "Invalid JSON body" });
  }

  const registryId = normalizeRegistryId(body.registryId);
  if (!registryId) {
    return json(400, { ok: false, error: "Missing or invalid registryId" });
  }

  const db = getFirestore(getAdminApp());
  const referenced = await scanReferencedRegistryIds(db);
  if (referenced.has(registryId)) {
    return json(409, {
      ok: false,
      error: "Title is on a list; remove it from lists before deleting from the catalog",
    });
  }

  const ref = db.collection("titleRegistry").doc(registryId);
  const snap = await ref.get();
  if (!snap.exists) {
    return json(404, { ok: false, error: "titleRegistry document not found" });
  }

  await ref.delete();
  return json(200, { ok: true, registryId });
};

const { wrapNetlifyHandler } = require("../src/api-lib/vercel-adapter");
module.exports = wrapNetlifyHandler(exports.handler);
