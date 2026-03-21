/**
 * Scheduled: daily TMDB sync → Firestore upcomingAlerts (titleRegistry only).
 * Netlify cron 3:00 UTC. Requires TMDB_API_KEY + FIREBASE_SERVICE_ACCOUNT.
 *
 * Do not rely on curling this URL — Netlify often rejects HTTP calls to **scheduled** functions quickly.
 * Use `trigger-upcoming-sync` for manual/curl runs instead.
 */

const { runUpcomingSyncCore } = require("./lib/execute-upcoming-sync");

exports.handler = async (event) => {
  const trigger = event?.headers?.["x-netlify-event"] || event?.httpMethod || "unknown";
  console.log("check-upcoming: start", JSON.stringify({ trigger }));

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Access-Control-Allow-Origin": "*" } };
  }

  try {
    const result = await runUpcomingSyncCore(20000);
    console.log("check-upcoming: done", JSON.stringify(result));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, ...result }),
    };
  } catch (e) {
    console.error("check-upcoming:", e);
    const code = e.statusCode || 500;
    return {
      statusCode: code,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: e.message || String(e) }),
    };
  }
};
