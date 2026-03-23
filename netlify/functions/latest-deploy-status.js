/**
 * Latest Netlify deploy for the site (for Admin UI), including `error_message` on failure.
 *
 * Requires server env: `NETLIFY_API_TOKEN`, `NETLIFY_SITE_ID` (same UUID as `VITE_NETLIFY_SITE_ID`).
 * GET + `Authorization: Bearer <Firebase ID token>`; caller must be an admin UID.
 */

const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { ADMIN_UIDS } = require("./lib/admin-uids");

/**
 * @returns {import('firebase-admin/app').App}
 */
function getApp() {
  if (global.__fbAdmin) return global.__fbAdmin;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT not set");
  const key = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
  const app = initializeApp({ credential: cert(key) });
  global.__fbAdmin = app;
  return app;
}

function corsHeaders() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

/**
 * @param {import('@netlify/functions').HandlerEvent} event
 */
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(), body: "" };
  }

  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers: corsHeaders(),
      body: JSON.stringify({ ok: false, error: "method_not_allowed" }),
    };
  }

  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    return {
      statusCode: 401,
      headers: corsHeaders(),
      body: JSON.stringify({ ok: false, error: "unauthorized" }),
    };
  }

  let uid;
  try {
    uid = (await getAuth(getApp()).verifyIdToken(authHeader.slice(7))).uid;
  } catch {
    return {
      statusCode: 401,
      headers: corsHeaders(),
      body: JSON.stringify({ ok: false, error: "invalid_token" }),
    };
  }

  if (!ADMIN_UIDS.has(uid)) {
    return {
      statusCode: 403,
      headers: corsHeaders(),
      body: JSON.stringify({ ok: false, error: "forbidden" }),
    };
  }

  const apiToken = process.env.NETLIFY_API_TOKEN && String(process.env.NETLIFY_API_TOKEN).trim();
  const siteId = process.env.NETLIFY_SITE_ID && String(process.env.NETLIFY_SITE_ID).trim();

  if (!apiToken || !siteId) {
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ ok: false, error: "not_configured" }),
    };
  }

  const url = `https://api.netlify.com/api/v1/sites/${encodeURIComponent(siteId)}/deploys?per_page=1`;

  let res;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e || "");
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ ok: false, error: "fetch_failed", message: msg }),
    };
  }

  const rawText = await res.text();
  if (!res.ok) {
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        ok: false,
        error: "netlify_api",
        status: res.status,
        message: rawText.slice(0, 800),
      }),
    };
  }

  let list;
  try {
    list = JSON.parse(rawText);
  } catch {
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ ok: false, error: "invalid_json" }),
    };
  }

  const deploy = Array.isArray(list) && list.length > 0 ? list[0] : null;
  if (!deploy || typeof deploy !== "object") {
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ ok: true, deploy: null }),
    };
  }

  const errorMessage =
    typeof deploy.error_message === "string" && deploy.error_message.trim()
      ? deploy.error_message.trim()
      : null;
  const summary =
    typeof deploy.summary === "string" && deploy.summary.trim() ? deploy.summary.trim() : null;
  const state = typeof deploy.state === "string" ? deploy.state : "unknown";

  return {
    statusCode: 200,
    headers: corsHeaders(),
    body: JSON.stringify({
      ok: true,
      deploy: {
        state,
        error_message: errorMessage,
        summary: summary && summary !== errorMessage ? summary : null,
        branch: typeof deploy.branch === "string" ? deploy.branch : null,
        deploy_ssl_url: typeof deploy.ssl_url === "string" ? deploy.ssl_url : null,
        admin_url: typeof deploy.admin_url === "string" ? deploy.admin_url : null,
        title: typeof deploy.title === "string" ? deploy.title : null,
      },
    }),
  };
};
