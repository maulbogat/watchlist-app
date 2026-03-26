/**
 * Shared helpers for invite / allowlist API routes.
 */

/**
 * @param {string} email
 * @returns {string}
 */
function normalizeInviteEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

/**
 * @param {string} email
 * @returns {boolean}
 */
function isValidEmailFormat(email) {
  const e = normalizeInviteEmail(email);
  if (!e || e.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

/**
 * @param {string} email
 * @returns {string}
 */
function maskEmailForLog(email) {
  const e = String(email || "").trim();
  const at = e.indexOf("@");
  if (at <= 0) return "***";
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  const prefix = local.slice(0, 2);
  return `${prefix}***@${domain}`;
}

/**
 * @param {import('@netlify/functions').HandlerEvent} event
 * @returns {string | null}
 */
function getBearerToken(event) {
  const raw = (event.headers?.authorization || event.headers?.Authorization || "").trim();
  if (!raw.toLowerCase().startsWith("bearer ")) return null;
  return raw.slice(7).trim() || null;
}

module.exports = {
  normalizeInviteEmail,
  isValidEmailFormat,
  maskEmailForLog,
  getBearerToken,
};
