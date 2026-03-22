/**
 * Netlify serverless function: **check-upcoming**
 *
 * **Trigger:** Netlify **scheduled** cron (e.g. daily ~03:00 UTC) and ad-hoc HTTP (GET/POST/OPTIONS).
 * Runs the same core as `trigger-upcoming-sync` via `runUpcomingSyncCore`.
 *
 * **Firestore writes (via `lib/sync-upcoming-alerts.js`):**
 * - **`upcomingAlerts/{docId}`** — merge upserts for TV/movie/sequel alerts (see `UpcomingAlertDoc` typedef in `sync-upcoming-alerts.js`).
 * - **`syncState/upcomingAlerts`** — cursor `lastRegistryDocId`, counts, `lastCompletedAt` / `updatedAt` for paginated registry sync.
 * - Deletes stale/expired/orphaned `upcomingAlerts` docs during full completion passes.
 *
 * Do not rely on curling the **scheduled** function URL — use `trigger-upcoming-sync` for manual runs.
 *
 * @module netlify/functions/check-upcoming
 */

/**
 * @typedef {import('../../src/types/index.js').UpcomingAlert} UpcomingAlert
 *
 * Partial sync result JSON returned in the HTTP body (`ok: true` branch).
 * @typedef {{
 *   ok: true,
 *   rowsChecked?: number,
 *   alertsUpserted?: number,
 *   pruned?: number,
 *   expiredRemoved?: number,
 *   completed: boolean,
 *   lastRegistryDocId?: string | null,
 *   totalRows?: number | null,
 *   budgetMs?: number,
 *   elapsedMs?: number,
 *   message?: string
 * }} CheckUpcomingSyncResultBody
 */

const { runUpcomingSyncCore } = require("./lib/execute-upcoming-sync");

/**
 * @param {import('@netlify/functions').HandlerEvent} event
 * @param {import('@netlify/functions').HandlerContext} [context]
 * @returns {Promise<import('@netlify/functions').HandlerResponse>}
 */
exports.handler = async (event, context) => {
  const trigger = event?.headers?.["x-netlify-event"] || event?.httpMethod || "unknown";
  console.log("check-upcoming: start", JSON.stringify({ trigger }));

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Access-Control-Allow-Origin": "*" } };
  }

  try {
    // Stay under Netlify's 30s wall; paginated registry + completion (prune) need headroom.
    const result = await runUpcomingSyncCore(21000);
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
