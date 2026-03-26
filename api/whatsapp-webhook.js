/**
 * WhatsApp Cloud API webhook (Meta).
 * GET: subscription verification. POST: inbound messages → IMDb → watchlist (Admin) + Graph reply.
 * Always returns HTTP 200 for POST so Meta does not retry aggressively.
 */

const crypto = require("crypto");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const { createFunctionLogger } = require("../src/api-lib/logger");
const { checkFirestoreQuota, QuotaExceededError } = require("../src/api-lib/firestore-guard");
const { getPhoneIndexEntry, phoneIndexDocId } = require("../src/api-lib/phone-index.js");
const { sendWhatsAppText } = require("../src/api-lib/whatsapp-graph.js");
const { netlifyEventFromReq, sendNetlifyResponse } = require("../src/api-lib/vercel-adapter");

const APP_NAME = "watchlist-admin";

const logEvent = createFunctionLogger("whatsapp-webhook");

/** @type {Map<string, number[]>} */
const rateBuckets = new Map();

/**
 * @param {import('@netlify/functions').HandlerEvent} event
 * @returns {string}
 */
function getRawBodyString(event) {
  const b = event.body;
  if (b == null) return "";
  if (typeof b === "string") return b;
  if (Buffer.isBuffer(b)) return b.toString("utf8");
  return "";
}

/**
 * @param {Record<string, string | string[] | undefined> | undefined} headers
 * @param {string} name
 * @returns {string | undefined}
 */
function headerInsensitive(headers, name) {
  if (!headers || typeof headers !== "object") return undefined;
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) {
      const v = headers[k];
      if (Array.isArray(v)) return v[0];
      if (v != null) return String(v);
    }
  }
  return undefined;
}

/**
 * @param {string} rawBody
 * @param {string | undefined} signatureHeader
 * @param {string | undefined} appSecret
 * @returns {boolean}
 */
function verifyMetaSignature256(rawBody, signatureHeader, appSecret) {
  if (!signatureHeader || !appSecret) return false;
  const prefix = "sha256=";
  if (!signatureHeader.startsWith(prefix)) return false;
  const theirHex = signatureHeader.slice(prefix.length);
  let theirBuf;
  try {
    theirBuf = Buffer.from(theirHex, "hex");
  } catch {
    return false;
  }
  if (theirBuf.length !== 32) return false;
  const hmac = crypto.createHmac("sha256", appSecret);
  hmac.update(rawBody, "utf8");
  const ourBuf = hmac.digest();
  try {
    return crypto.timingSafeEqual(ourBuf, theirBuf);
  } catch {
    return false;
  }
}

/**
 * @param {string} phoneDigits
 * @returns {boolean} true if limited (caller should skip processing)
 */
function isRateLimited(phoneDigits) {
  const now = Date.now();
  const windowMs = 60_000;
  let arr = rateBuckets.get(phoneDigits) || [];
  arr = arr.filter((t) => now - t < windowMs);
  if (arr.length >= 5) {
    rateBuckets.set(phoneDigits, arr);
    return true;
  }
  arr.push(now);
  rateBuckets.set(phoneDigits, arr);
  return false;
}

/**
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<string>}
 */
async function rawPostBodyString(req) {
  if (typeof req.body === "string") return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  if (req.body != null && typeof req.body === "object") return JSON.stringify(req.body);
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

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
    const rawBody = getRawBodyString(event);
    const sigHeader = headerInsensitive(event.headers, "x-hub-signature-256");
    const appSecret = process.env.WHATSAPP_APP_SECRET;
    console.log("[wa-debug] x-hub-signature-256 present:", Boolean(sigHeader));
    console.log("[wa-debug] WHATSAPP_APP_SECRET set:", Boolean(appSecret && String(appSecret).trim()));
    console.log("[wa-debug] raw body (first 20 chars):", rawBody.slice(0, 20));
    if (!sigHeader) {
      console.log("[wa-debug] signature verification failed: missing x-hub-signature-256 header");
      return { statusCode: 403, headers: { "Content-Type": "text/plain" }, body: "Forbidden" };
    }
    const verifyOk = Boolean(appSecret && verifyMetaSignature256(rawBody, sigHeader, appSecret));
    console.log("[wa-debug] verifyMetaSignature256 result:", verifyOk);
    if (!appSecret || !verifyOk) {
      if (!appSecret || !String(appSecret).trim()) {
        console.log("[wa-debug] signature verification failed: WHATSAPP_APP_SECRET missing or empty");
      } else {
        const prefix = "sha256=";
        if (typeof sigHeader !== "string" || !sigHeader.startsWith(prefix)) {
          console.log("[wa-debug] signature verification failed: x-hub-signature-256 does not start with sha256=");
        } else {
          const theirHex = sigHeader.slice(prefix.length);
          let theirBuf;
          try {
            theirBuf = Buffer.from(theirHex, "hex");
          } catch {
            theirBuf = null;
          }
          if (!theirBuf || theirBuf.length !== 32) {
            console.log("[wa-debug] signature verification failed: signature is not a 32-byte hex digest");
          } else {
            console.log("[wa-debug] signature verification failed: HMAC sha256 mismatch (body, secret, or signature)");
          }
        }
      }
      return { statusCode: 403, headers: { "Content-Type": "text/plain" }, body: "Forbidden" };
    }

    const db = getFirestore(getApp());
    try {
      await checkFirestoreQuota(db, 10);
    } catch (e) {
      if (e instanceof QuotaExceededError) {
        logEvent({ type: "quota.exceeded", period: e.period, function: "whatsapp-webhook" });
        let body;
        try {
          body = rawBody ? JSON.parse(rawBody) : {};
        } catch {
          return json200(event);
        }
        const inbound = extractInboundTextMessage(body);
        if (inbound) {
          const senderDigits = phoneIndexDocId(inbound.from);
          try {
            await sendWhatsAppText(
              senderDigits,
              `Service temporarily unavailable (${e.period} quota reached). Try again later.`
            );
          } catch {
            /* ignore */
          }
        }
        return json200(event);
      }
      throw e;
    }

    let body = {};
    try {
      body = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      return json200(event);
    }

    const inbound = extractInboundTextMessage(body);
    if (!inbound) {
      return json200(event);
    }

    const senderDigits = phoneIndexDocId(inbound.from);
    if (isRateLimited(senderDigits)) {
      logEvent({ type: "whatsapp.rate_limit", senderMasked: maskPhone(senderDigits) });
      return json200(event);
    }

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

/**
 * @param {import('http').IncomingMessage & { body?: unknown }} req
 * @param {import('http').ServerResponse} res
 */
module.exports = async (req, res) => {
  try {
    let event;
    if (req.method === "POST") {
      const raw = await rawPostBodyString(req);
      event = netlifyEventFromReq({
        method: "POST",
        headers: { ...req.headers },
        body: raw,
        url: typeof req.url === "string" ? req.url : "",
        query: req.query,
      });
    } else {
      event = netlifyEventFromReq(req);
    }
    const result = await exports.handler(event, {});
    sendNetlifyResponse(res, result);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
};

module.exports.config = {
  api: {
    bodyParser: false,
  },
};
