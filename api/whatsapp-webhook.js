/**
 * WhatsApp Cloud API webhook (Meta).
 * GET: subscription verification. POST: incoming events (acknowledge; extend for business logic).
 */

const { createFunctionLogger } = require("./lib/logger");

const logEvent = createFunctionLogger("whatsapp-webhook");

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
    // Meta expects 200 quickly; validate X-Hub-Signature-256 when you add handlers.
    return { statusCode: 200, body: "" };
  }

  return { statusCode: 405, headers: { "Content-Type": "text/plain" }, body: "Method Not Allowed" };
};

const { wrapNetlifyHandler } = require("./lib/vercel-adapter");
module.exports = wrapNetlifyHandler(exports.handler);
