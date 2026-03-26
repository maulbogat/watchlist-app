/**
 * Send transactional email via Resend HTTP API (no extra npm dependency).
 *
 * @param {{ to: string, subject: string, text: string, html: string }} opts
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
async function sendResendEmail(opts) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !String(key).trim()) {
    return { ok: false, error: "RESEND_API_KEY not configured" };
  }
  const from = (process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev").trim();
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [opts.to],
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
    }),
  });
  if (!res.ok) {
    let errText = res.statusText;
    try {
      const j = await res.json();
      if (j && j.message) errText = String(j.message);
    } catch {
      /* ignore */
    }
    return { ok: false, error: errText || `HTTP ${res.status}` };
  }
  return { ok: true };
}

module.exports = { sendResendEmail };
