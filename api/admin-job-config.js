const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { readJobConfig, setCheckUpcomingEnabled } = require("../src/api-lib/job-config");

const APP_NAME = "watchlist-admin";

function getAdminApp() {
  if (global.__watchlistAdminApp) return global.__watchlistAdminApp;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT not set");
  const key = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
  const app = initializeApp({ credential: cert(key), projectId: key.project_id }, APP_NAME);
  global.__watchlistAdminApp = app;
  return app;
}

function corsHeaders() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function toIsoOrNull(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && value !== null && typeof value.toDate === "function") {
    const d = value.toDate();
    return d instanceof Date ? d.toISOString() : null;
  }
  if (typeof value === "string") return value;
  return null;
}

function normalizeJobConfig(raw) {
  return {
    checkUpcomingEnabled: raw.checkUpcomingEnabled !== false,
    lastRunAt: toIsoOrNull(raw.lastRunAt),
    lastRunStatus: raw.lastRunStatus || null,
    lastRunMessage: raw.lastRunMessage || null,
    lastRunResult: raw.lastRunResult || null,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders() };
  }

  const db = getFirestore(getAdminApp());
  try {
    if (event.httpMethod === "GET") {
      const cfg = await readJobConfig(db);
      return {
        statusCode: 200,
        headers: corsHeaders(),
        body: JSON.stringify({ ok: true, config: normalizeJobConfig(cfg) }),
      };
    }

    if (event.httpMethod === "POST") {
      const body = event.body ? JSON.parse(event.body) : {};
      const enabled = Boolean(body?.checkUpcomingEnabled);
      const cfg = await setCheckUpcomingEnabled(db, enabled);
      return {
        statusCode: 200,
        headers: corsHeaders(),
        body: JSON.stringify({ ok: true, config: normalizeJobConfig(cfg) }),
      };
    }

    return {
      statusCode: 405,
      headers: corsHeaders(),
      body: JSON.stringify({ ok: false, error: "Use GET or POST" }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ ok: false, error: e?.message || String(e) }),
    };
  }
};

const { wrapNetlifyHandler } = require("../src/api-lib/vercel-adapter");
module.exports = wrapNetlifyHandler(exports.handler);
