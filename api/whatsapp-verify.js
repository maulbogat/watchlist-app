/**
 * Link WhatsApp number → Firebase user: send / verify 6-digit code (Admin + Graph API).
 * POST JSON. Authorization: Bearer <Firebase ID token>. `uid` is taken from the token only.
 */

const crypto = require("crypto");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

const { createFunctionLogger } = require("../src/api-lib/logger");
const { sendWhatsAppText } = require("../src/api-lib/whatsapp-graph.js");
const {
  getPhoneIndexEntry,
  setPhoneIndexEntry,
  phoneIndexDocId,
} = require("../src/api-lib/phone-index.js");

const APP_NAME = "watchlist-admin";

const logEvent = createFunctionLogger("whatsapp-verify");

/** @returns {import('firebase-admin/app').App} */
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

/**
 * @param {number} status
 * @param {Record<string, unknown>} body
 * @param {import('@netlify/functions').HandlerEvent} event
 */
function json(status, body, event) {
  return {
    statusCode: status,
    headers: { ...corsHeaders(event), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/**
 * @param {import('@netlify/functions').HandlerEvent} event
 */
exports.handler = async (event) => {
  try {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(event), body: "" };
  }

  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" }, event);
  }

  const authHeader = (event.headers?.authorization || event.headers?.Authorization || "").trim();
  if (!authHeader.startsWith("Bearer ")) {
    return json(401, { ok: false, error: "Missing Authorization" }, event);
  }

  let uid;
  try {
    const idToken = authHeader.slice(7);
    uid = (await getAuth(getApp()).verifyIdToken(idToken)).uid;
  } catch {
    return json(401, { ok: false, error: "Invalid token" }, event);
  }

  let body;
  try {
    body = typeof event.body === "string" ? JSON.parse(event.body || "{}") : event.body || {};
  } catch {
    return json(400, { ok: false, error: "Invalid JSON" }, event);
  }

  if (body && typeof body === "object" && typeof body.uid === "string" && body.uid !== uid) {
    return json(403, { ok: false, error: "Token uid mismatch" }, event);
  }

  const phone = phoneIndexDocId(body.phone);
  if (!phone) {
    return json(400, { ok: false, error: "phone_required" }, event);
  }

  const db = getFirestore(getApp());

  if (body.code != null && String(body.code).trim() !== "") {
    const code = String(body.code).replace(/\D/g, "").slice(0, 6);
    if (code.length !== 6) {
      return json(200, { ok: false, error: "invalid_code" }, event);
    }

    const ref = db.collection("verificationCodes").doc(phone);
    const snap = await ref.get();
    if (!snap.exists) {
      logEvent({ type: "whatsapp.verify.fail", reason: "no_doc", phoneMasked: maskPhone(phone) });
      return json(200, { ok: false, error: "invalid_code" }, event);
    }

    const data = snap.data() || {};
    if (data.uid !== uid) {
      return json(200, { ok: false, error: "invalid_code" }, event);
    }
    if (String(data.code) !== code) {
      logEvent({ type: "whatsapp.verify.fail", reason: "bad_code", phoneMasked: maskPhone(phone) });
      return json(200, { ok: false, error: "invalid_code" }, event);
    }

    const exp = data.expiresAt;
    if (typeof exp === "string" && Date.parse(exp) < Date.now()) {
      await ref.delete().catch(() => {});
      return json(200, { ok: false, error: "invalid_code" }, event);
    }

    const defaultAddListId = typeof data.defaultAddListId === "string" ? data.defaultAddListId.trim() : "";
    const defaultListType = data.defaultListType === "shared" ? "shared" : "personal";
    if (!defaultAddListId) {
      await ref.delete().catch(() => {});
      return json(200, { ok: false, error: "invalid_code" }, event);
    }

    const taken = await getPhoneIndexEntry(db, phone);
    if (taken && taken.uid !== uid) {
      await ref.delete().catch(() => {});
      logEvent({ type: "whatsapp.verify.fail", reason: "phone_taken", phoneMasked: maskPhone(phone) });
      return json(200, { ok: false, error: "invalid_code" }, event);
    }

    await setPhoneIndexEntry(db, phone, { uid, defaultAddListId, defaultListType });
    const userRef = db.collection("users").doc(uid);
    await userRef.set({ phoneNumbers: FieldValue.arrayUnion(phone) }, { merge: true });
    await ref.delete();

    logEvent({ type: "whatsapp.verify.ok", phoneMasked: maskPhone(phone) });
    return json(200, { ok: true, verified: true }, event);
  }

  const defaultAddListId = typeof body.defaultAddListId === "string" ? body.defaultAddListId.trim() : "";
  const defaultListType = body.defaultListType === "shared" ? "shared" : "personal";
  if (!defaultAddListId) {
    return json(400, { ok: false, error: "default_list_required" }, event);
  }

  const taken = await getPhoneIndexEntry(db, phone);
  if (taken && taken.uid !== uid) {
    return json(409, { ok: false, error: "phone_registered_elsewhere" }, event);
  }

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  await db.collection("verificationCodes").doc(phone).set({
    code,
    uid,
    expiresAt,
    createdAt: new Date().toISOString(),
    defaultAddListId,
    defaultListType,
  });

  try {
    await sendWhatsAppText(phone, `Your watchlist verification code: ${code}`);
  } catch (e) {
    const msg = e && typeof e === "object" && "message" in e ? String(e.message) : String(e);
    logEvent({ type: "whatsapp.send_code.fail", phoneMasked: maskPhone(phone), error: msg });
    await db.collection("verificationCodes").doc(phone).delete().catch(() => {});
    return json(502, { ok: false, error: "whatsapp_send_failed" }, event);
  }

  logEvent({ type: "whatsapp.send_code.ok", phoneMasked: maskPhone(phone) });
  return json(200, { ok: true }, event);
  } catch (err) {
    console.error("whatsapp-verify unhandled error:", err);
    if (err instanceof Error) {
      console.error("whatsapp-verify message:", err.message);
      console.error("whatsapp-verify stack:", err.stack);
    } else {
      console.error("whatsapp-verify non-Error payload:", err);
    }
    return json(502, { ok: false, error: "internal_error" }, event);
  }
};

/**
 * @param {string} phoneDigits
 */
function maskPhone(phoneDigits) {
  const d = String(phoneDigits || "").replace(/\D/g, "");
  if (d.length <= 4) return "****";
  return `****${d.slice(-4)}`;
}

const { wrapNetlifyHandler } = require("../src/api-lib/vercel-adapter");
module.exports = wrapNetlifyHandler(exports.handler);
