/**
 * HTTP-invokable upcoming sync (same work as check-upcoming).
 *
 * Netlify **scheduled** functions are not reliably invokable via `curl` to their URL (fast failure / Internal Error).
 * Use this function instead:
 *
 *   curl -X POST "https://YOUR-SITE.netlify.app/.netlify/functions/trigger-upcoming-sync"
 *
 * Optional: set UPCOMING_SYNC_TRIGGER_SECRET in Netlify env, then:
 *   curl -X POST -H "Authorization: Bearer YOUR_SECRET" "https://..."
 */

const { runUpcomingSyncCore } = require("./lib/execute-upcoming-sync");

function corsHeaders() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders() };
  }

  if (event.httpMethod !== "POST" && event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers: corsHeaders(),
      body: JSON.stringify({ ok: false, error: "Use GET or POST" }),
    };
  }

  const secret = process.env.UPCOMING_SYNC_TRIGGER_SECRET;
  if (secret && String(secret).trim()) {
    const auth = (event.headers?.authorization || event.headers?.Authorization || "").trim();
    if (auth !== `Bearer ${secret.trim()}`) {
      return {
        statusCode: 401,
        headers: corsHeaders(),
        body: JSON.stringify({ ok: false, error: "Unauthorized" }),
      };
    }
  }

  console.log("trigger-upcoming-sync: start", JSON.stringify({ method: event.httpMethod }));

  try {
    const result = await runUpcomingSyncCore(20000);
    console.log("trigger-upcoming-sync: done", JSON.stringify(result));
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ ok: true, ...result }),
    };
  } catch (e) {
    console.error("trigger-upcoming-sync:", e);
    const code = e.statusCode || 500;
    return {
      statusCode: code,
      headers: corsHeaders(),
      body: JSON.stringify({ ok: false, error: e.message || String(e) }),
    };
  }
};
