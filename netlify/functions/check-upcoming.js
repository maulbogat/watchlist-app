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
const { getAdminApp, runUpcomingSyncCore } = require("./lib/execute-upcoming-sync");
const { readJobConfig, writeCheckUpcomingRunResult } = require("./lib/job-config");
const { createFunctionLogger } = require("./lib/logger");

const logEvent = createFunctionLogger("check-upcoming");

/**
 * @param {import('@netlify/functions').HandlerEvent} event
 * @param {import('@netlify/functions').HandlerContext} [context]
 * @returns {Promise<import('@netlify/functions').HandlerResponse>}
 */
exports.handler = async (event, context) => {
  const startedAt = Date.now();
  const trigger = event?.headers?.["x-netlify-event"] || event?.httpMethod || "unknown";
  console.log("check-upcoming: start", JSON.stringify({ trigger }));
  try {
    const firstLogResult = logEvent({ type: "function.invoked", trigger });
    console.log("check-upcoming: first logger call result", firstLogResult);
  } catch (firstLogErr) {
    console.log(
      "check-upcoming: first logger call error",
      firstLogErr instanceof Error ? firstLogErr.message : String(firstLogErr || "")
    );
  }

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
    console.log("check-upcoming: skipped", JSON.stringify(skipPayload));
    logEvent({ type: "job.skipped", reason: "disabled" });
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, skipped: true, reason: skipPayload.message }),
    };
  }

  try {
    // Stay under Netlify's 30s wall; paginated registry + completion (prune) need headroom.
    const result = await runUpcomingSyncCore(21000);
    console.log(
      "check-upcoming: writes",
      JSON.stringify({
        performed: result?.alertsUpserted ?? 0,
        skipped: result?.writesSkipped ?? 0,
      })
    );
    console.log("check-upcoming: done", JSON.stringify(result));
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
