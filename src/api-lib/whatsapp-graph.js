/**
 * Outbound WhatsApp Cloud API (Meta Graph) — text messages.
 * @param {string} toDigits E.164 digits only (no +), per Graph API `to` field.
 * @param {string} bodyText
 * @returns {Promise<void>}
 */
async function sendWhatsAppText(toDigits, bodyText) {
  console.log(
    "[reply-debug] sendWhatsAppText called, phoneNumberId set: " +
      Boolean(process.env.WHATSAPP_PHONE_NUMBER_ID) +
      ", token set: " +
      Boolean(process.env.WHATSAPP_TOKEN)
  );
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    throw new Error("WHATSAPP_TOKEN or WHATSAPP_PHONE_NUMBER_ID not set");
  }
  const to = String(toDigits || "").replace(/\D/g, "");
  if (!to) throw new Error("Invalid WhatsApp recipient");
  const url = `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`;
  const res = await fetch(url, {
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
  console.log("[reply-debug] graph api response status: " + res.status);
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`WhatsApp Graph error ${res.status}: ${raw.slice(0, 200)}`);
  }
}

module.exports = { sendWhatsAppText };
