/**
 * WhatsApp Cloud API webhook (Meta).
 * GET: subscription verification. POST: inbound messages → IMDb → watchlist (Admin) + Graph reply.
 * Always returns HTTP 200 for POST so Meta does not retry aggressively.
 */

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const { createFunctionLogger } = require("../src/api-lib/logger");
const { getPhoneIndexEntry, phoneIndexDocId } = require("../src/api-lib/phone-index.js");
const { sendWhatsAppText } = require("../src/api-lib/whatsapp-graph.js");

const APP_NAME = "watchlist-admin";

const logEvent = createFunctionLogger("whatsapp-webhook");

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
 * @param {string} digits
 */
function maskPhone(digits) {
  const d = String(digits || "").replace(/\D/g, "");
  if (d.length <= 4) return "****";
  return `****${d.slice(-4)}`;
}

/**
 * @param {string} text
 * @returns {string | null} tt… id
 */
function extractImdbId(text) {
  const s = String(text || "");
  const withHost = s.match(/imdb\.com\/title\/(tt\d{7,})/i);
  if (withHost) return withHost[1].toLowerCase();
  const bare = s.match(/\b(tt\d{7,})\b/i);
  return bare ? bare[1].toLowerCase() : null;
}

/**
 * @param {unknown} body
 * @returns {{ from: string, text: string } | null}
 */
function extractInboundTextMessage(body) {
  if (!body || typeof body !== "object") return null;
  const entry = body.entry;
  if (!Array.isArray(entry) || !entry[0]) return null;
  const changes = entry[0].changes;
  if (!Array.isArray(changes) || !changes[0]) return null;
  const value = changes[0].value;
  if (!value || typeof value !== "object") return null;
  const messages = value.messages;
  if (!Array.isArray(messages) || !messages[0]) return null;
  const m = messages[0];
  if (m.type !== "text" || !m.text || typeof m.text.body !== "string") return null;
  return { from: String(m.from || ""), text: m.text.body };
}

function publicAppBaseUrl() {
  const explicit = process.env.APP_PUBLIC_URL || process.env.VITE_APP_ORIGIN;
  if (explicit) return String(explicit).replace(/\/$/, "");
  const v = process.env.VERCEL_URL;
  if (v) return `https://${String(v).replace(/^https?:\/\//, "")}`;
  return "https://watchlist-trailers.vercel.app";
}

/**
 * @param {import('@netlify/functions').HandlerEvent} event
 */
function json200(event, obj) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(obj != null ? obj : { ok: true }),
  };
}

/**
 * @param {import('@netlify/functions').HandlerEvent} event
 */
exports.handler = async (event) => {
  if (event.httpMethod === "GET") {
    const q = event.queryStringParameters || {};
    const mode = q["hub.mode"];
    const token = q["hub.verify_token"];
    const challenge = q["hub.challenge"];
    const expected = process.env.WHATSAPP_VERIFY_TOKEN;

    if (!expected) {
      logEvent({ type: "whatsapp.verify.missing_token_env" });
      return { statusCode: 503, headers: { "Content-Type": "text/plain" }, body: "not configured" };
    }

    if (mode === "subscribe" && token === expected && challenge) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: challenge,
      };
    }

    logEvent({ type: "whatsapp.verify.rejected", mode: mode || null });
    return { statusCode: 403, headers: { "Content-Type": "text/plain" }, body: "Forbidden" };
  }

  if (event.httpMethod === "POST") {
    let body = {};
    try {
      body = typeof event.body === "string" ? JSON.parse(event.body || "{}") : event.body || {};
    } catch {
      return json200(event);
    }

    const inbound = extractInboundTextMessage(body);
    if (!inbound) {
      return json200(event);
    }

    const senderDigits = phoneIndexDocId(inbound.from);
    const addFromImdbModule = require("./add-from-imdb.js");
    const perform = addFromImdbModule.performAddFromImdbByUid;
    if (typeof perform !== "function") {
      logEvent({ type: "whatsapp.missing_perform" });
      return json200(event);
    }

    try {
      const imdbId = extractImdbId(inbound.text);
      if (!imdbId) {
        logEvent({ type: "whatsapp.imdb.skip", reason: "no_imdb", senderMasked: maskPhone(senderDigits) });
        await sendWhatsAppText(
          senderDigits,
          "Send me an IMDb link to add a title to your watchlist."
        );
        return json200(event);
      }

      const db = getFirestore(getApp());
      const entry = await getPhoneIndexEntry(db, senderDigits);
      if (!entry) {
        const base = publicAppBaseUrl();
        logEvent({ type: "whatsapp.imdb.skip", reason: "unregistered", senderMasked: maskPhone(senderDigits), imdbId });
        await sendWhatsAppText(
          senderDigits,
          `Your number is not registered. Visit ${base}/ to open the app, then use the profile menu → WhatsApp to connect your number.`
        );
        return json200(event);
      }

      const userSnap = await db.collection("users").doc(entry.uid).get();
      const u = userSnap.exists ? userSnap.data() || {} : {};
      const watchRegion = String(u.country || "")
        .trim()
        .toUpperCase()
        .slice(0, 2);

      const listId = entry.defaultListType === "shared" ? entry.defaultAddListId : null;
      const personalListId = entry.defaultListType === "personal" ? entry.defaultAddListId : null;

      const r = await perform(entry.uid, imdbId, listId, personalListId, watchRegion);
      const ok = r && r.body && r.body.ok === true;
      const added = r && r.body && r.body.added === true;
      const title = (r && r.body && typeof r.body.title === "string" && r.body.title) || "Title";
      const year = r && r.body && r.body.year != null && r.body.year !== "" ? String(r.body.year) : "—";

      if (ok && r.statusCode >= 200 && r.statusCode < 300) {
        if (added) {
          await sendWhatsAppText(senderDigits, `✓ Added: ${title} (${year})`);
        } else {
          await sendWhatsAppText(senderDigits, `✓ Already on your list: ${title} (${year})`);
        }
        logEvent({
          type: "whatsapp.imdb.done",
          imdbId,
          senderMasked: maskPhone(senderDigits),
          outcome: added ? "added" : "duplicate",
          statusCode: r.statusCode,
        });
      } else {
        await sendWhatsAppText(senderDigits, "Sorry, something went wrong. Try again later.");
        logEvent({
          type: "whatsapp.imdb.done",
          imdbId,
          senderMasked: maskPhone(senderDigits),
          outcome: "error",
          statusCode: r && r.statusCode,
        });
      }
    } catch (e) {
      const msg = e && typeof e === "object" && "message" in e ? String(e.message) : String(e);
      logEvent({ type: "whatsapp.imdb.error", senderMasked: maskPhone(senderDigits), error: msg });
      try {
        await sendWhatsAppText(senderDigits, "Sorry, something went wrong. Try again later.");
      } catch {
        /* ignore */
      }
    }

    return json200(event);
  }

  return { statusCode: 405, headers: { "Content-Type": "text/plain" }, body: "Method Not Allowed" };
};

const { wrapNetlifyHandler } = require("../src/api-lib/vercel-adapter");
module.exports = wrapNetlifyHandler(exports.handler);
