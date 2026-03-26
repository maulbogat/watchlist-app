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
 *   writesSkipped?: number,
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

const { getFirestore } = require("firebase-admin/firestore");
const { getAdminApp, runUpcomingSyncCore } = require("../src/api-lib/execute-upcoming-sync");
const { checkFirestoreQuota, QuotaExceededError } = require("../src/api-lib/firestore-guard");
const { readJobConfig, writeCheckUpcomingRunResult } = require("../src/api-lib/job-config");
const { createFunctionLogger } = require("../src/api-lib/logger");

const logEvent = createFunctionLogger("check-upcoming");

/**
 * @param {import('@netlify/functions').HandlerEvent} event
 * @param {import('@netlify/functions').HandlerContext} [context]
 * @returns {Promise<import('@netlify/functions').HandlerResponse>}
 */
exports.handler = async (event, context) => {
  const startedAt = Date.now();
  const trigger =
    event?.headers?.["x-netlify-event"] ||
    (event?.headers?.["x-vercel-cron"] ? "vercel-cron" : null) ||
    event?.httpMethod ||
    "unknown";
  logEvent({ type: "function.invoked", trigger });

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Access-Control-Allow-Origin": "*" } };
  }

  const body = (() => {
    try {
      return event?.body ? JSON.parse(event.body) : {};
    } catch {
      return {};
    }
  })();
  const isManual = body?.trigger === "manual" || event?.httpMethod === "POST";

  const db = getFirestore(getAdminApp());
  const config = await readJobConfig(db);
  if (!isManual && config.checkUpcomingEnabled === false) {
    const skipPayload = {
      status: "skipped",
      message: "check-upcoming disabled by meta/jobConfig",
      trigger,
      result: { completed: true, skippedByConfig: true },
    };
    await writeCheckUpcomingRunResult(db, skipPayload);
    logEvent({ type: "job.skipped", reason: "disabled" });
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, skipped: true, reason: skipPayload.message }),
    };
  }

  try {
    await checkFirestoreQuota(db, 50);
    // Stay under Netlify's 30s wall; paginated registry + completion (prune) need headroom.
    const result = await runUpcomingSyncCore(21000);
    await writeCheckUpcomingRunResult(db, {
      status: "success",
      message: "check-upcoming completed",
      trigger,
      result,
    });
    logEvent({
      type: "job.completed",
      titlesChecked: typeof result?.rowsChecked === "number" ? result.rowsChecked : 0,
      titlesSkipped: typeof result?.rowsSkipped === "number" ? result.rowsSkipped : 0,
      alertsWritten: typeof result?.alertsUpserted === "number" ? result.alertsUpserted : 0,
      alertsSkippedUnchanged: typeof result?.writesSkipped === "number" ? result.writesSkipped : 0,
      durationMs: Date.now() - startedAt,
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, ...result }),
    };
  } catch (e) {
    if (e instanceof QuotaExceededError) {
      logEvent({
        type: "quota.exceeded",
        period: e.period,
        function: "check-upcoming",
        trigger,
      });
      await writeCheckUpcomingRunResult(db, {
        status: "skipped",
        message: `Quota exceeded (${e.period})`,
        trigger,
        result: { completed: true, skippedByQuota: true, period: e.period },
      });
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ok: true,
          skipped: true,
          reason: "quota_exceeded",
          period: e.period,
        }),
      };
    }
    console.error("check-upcoming:", e);
    const message = e instanceof Error ? e.message : String(e);
    await writeCheckUpcomingRunResult(db, {
      status: "error",
      message,
      trigger,
      result: { completed: false },
    });
    logEvent({
      type: "job.failed",
      error: message,
      durationMs: Date.now() - startedAt,
    });
    const code = e.statusCode || 500;
    return {
      statusCode: code,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: message }),
    };
  }
};

const { wrapNetlifyHandler } = require("../src/api-lib/vercel-adapter");
module.exports = wrapNetlifyHandler(exports.handler);
