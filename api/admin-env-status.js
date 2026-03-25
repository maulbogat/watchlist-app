const SERVER_ENV_KEYS = [
  "TMDB_API_KEY",
  "OMDB_API_KEY",
  "FIREBASE_SERVICE_ACCOUNT",
  "AXIOM_TOKEN",
  "AXIOM_DATASET",
  "UPCOMING_SYNC_TRIGGER_SECRET",
];

function corsHeaders() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders() };
  }
  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers: corsHeaders(),
      body: JSON.stringify({ ok: false, error: "Use GET" }),
    };
  }

  const status = Object.fromEntries(
    SERVER_ENV_KEYS.map((key) => [key, Boolean(process.env[key] && String(process.env[key]).trim())])
  );
  // Optional site id for deploy dashboards / diagnostics (Vercel, Netlify legacy).
  status.SITE_ID = Boolean(
    (process.env.VITE_SITE_ID && String(process.env.VITE_SITE_ID).trim()) ||
      (process.env.VITE_NETLIFY_SITE_ID && String(process.env.VITE_NETLIFY_SITE_ID).trim()) ||
      (process.env.NETLIFY_SITE_ID && String(process.env.NETLIFY_SITE_ID).trim())
  );

  return {
    statusCode: 200,
    headers: corsHeaders(),
    body: JSON.stringify({ ok: true, status }),
  };
};

const { wrapNetlifyHandler } = require("./lib/vercel-adapter");
module.exports = wrapNetlifyHandler(exports.handler);
