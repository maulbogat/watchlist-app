const SERVER_ENV_KEYS = [
  "TMDB_API_KEY",
  "OMDB_API_KEY",
  "FIREBASE_SERVICE_ACCOUNT",
  "AXIOM_TOKEN",
  "AXIOM_DATASET",
  "UPCOMING_SYNC_TRIGGER_SECRET",
  "NETLIFY_API_TOKEN",
  "NETLIFY_SITE_ID",
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

  return {
    statusCode: 200,
    headers: corsHeaders(),
    body: JSON.stringify({ ok: true, status }),
  };
};
