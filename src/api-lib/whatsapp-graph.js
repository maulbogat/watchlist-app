const { createFunctionLogger } = require("./logger");

const logEvent = createFunctionLogger("whatsapp-graph");

/**
 * @param {string} digits
 * @returns {string}
 */
function maskPhone(digits) {
  const d = String(digits || "").replace(/\D/g, "");
  if (d.length <= 4) return "****";
  return `****${d.slice(-4)}`;
}

/**
 * Pulls Meta's structured error out of a Graph error body, e.g.
 * `{"error":{"message":"...","type":"OAuthException","code":190,"error_subcode":463}}`.
 * @param {string} raw
 * @returns {{ code: number | null, subcode: number | null, type: string | null, message: string | null }}
 */
function parseGraphError(raw) {
  try {
    const err = JSON.parse(raw).error || {};
    return {
      code: typeof err.code === "number" ? err.code : null,
      subcode: typeof err.error_subcode === "number" ? err.error_subcode : null,
      type: typeof err.type === "string" ? err.type : null,
      message: typeof err.message === "string" ? err.message.slice(0, 300) : null,
    };
  } catch {
    return { code: null, subcode: null, type: null, message: String(raw || "").slice(0, 300) || null };
  }
}

/**
 * Outbound WhatsApp Cloud API (Meta Graph) — text messages.
 * Every failure is logged as `whatsapp.send_failed` (with Meta's error code) before throwing,
 * so an expired token / deleted number / unlisted recipient is visible in Axiom even when
 * callers swallow the error.
 * @param {string} toDigits E.164 digits only (no +), per Graph API `to` field.
 * @param {string} bodyText
 * @returns {Promise<void>}
 */
async function sendWhatsAppText(toDigits, bodyText) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    logEvent({ type: "whatsapp.send_failed", reason: "missing_env" });
    throw new Error("WHATSAPP_TOKEN or WHATSAPP_PHONE_NUMBER_ID not set");
  }
  const to = String(toDigits || "").replace(/\D/g, "");
  if (!to) throw new Error("Invalid WhatsApp recipient");
  const url = `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`;

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: bodyText },
      }),
    });
  } catch (e) {
    logEvent({
      type: "whatsapp.send_failed",
      reason: "network",
      recipientMasked: maskPhone(to),
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }

  const raw = await res.text();
  if (!res.ok) {
    const graph = parseGraphError(raw);
    logEvent({
      type: "whatsapp.send_failed",
      reason: "graph_error",
      status: res.status,
      graphCode: graph.code,
      graphSubcode: graph.subcode,
      graphType: graph.type,
      graphMessage: graph.message,
      recipientMasked: maskPhone(to),
    });
    const err = new Error(`WhatsApp Graph error ${res.status}: ${raw.slice(0, 200)}`);
    Object.assign(err, { graphCode: graph.code, graphSubcode: graph.subcode });
    throw err;
  }
}

module.exports = { sendWhatsAppText, parseGraphError };
