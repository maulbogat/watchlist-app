/**
 * Admin UI: run the upcoming-alerts sync to completion by chaining POST /api/check-upcoming.
 * Each invocation is a fresh serverless instance, so TMDB requests are spaced here between batches
 * in addition to per-request spacing in `src/api-lib/tmdb-upcoming-fetch.js` on the server.
 */

/** Default pause between batch requests (ms). */
export const UPCOMING_ADMIN_BATCH_PAUSE_MS = 2500;

/** Safety valve if the cursor never reaches completed (misconfiguration or API change). */
export const UPCOMING_ADMIN_MAX_BATCHES = 5000;

export type CheckUpcomingApiBody = {
  ok?: boolean;
  skipped?: boolean;
  reason?: string;
  error?: string;
  completed?: boolean;
  alertsUpserted?: number;
  writesSkipped?: number;
  rowsChecked?: number;
  rowsSkipped?: number;
  totalRows?: number | null;
  lastRegistryDocId?: string | null;
  message?: string;
};

export type UpcomingRunProgress = {
  batch: number;
  last: CheckUpcomingApiBody;
};

export type RunCheckUpcomingTotals = {
  alertsUpserted: number;
  writesSkipped: number;
  rowsChecked: number;
};

export type RunCheckUpcomingSuccess =
  | {
      ok: true;
      batches: number;
      skipped: false;
      totals: RunCheckUpcomingTotals;
      last: CheckUpcomingApiBody;
    }
  | {
      ok: true;
      batches: number;
      skipped: true;
      reason: string;
      totals: RunCheckUpcomingTotals;
      last: CheckUpcomingApiBody;
    };

export type RunCheckUpcomingFailure = {
  ok: false;
  error: string;
  batches: number;
  last?: CheckUpcomingApiBody;
};

function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

/**
 * @param signal - When aborted during the wait, rejects with AbortError.
 */
export async function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const id = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      globalThis.clearTimeout(id);
      signal?.removeEventListener("abort", onAbort);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * POST /api/check-upcoming until `completed: true`, or stop on skipped (quota / config) or HTTP error.
 */
export async function runCheckUpcomingUntilComplete(options: {
  pauseMs?: number;
  maxBatches?: number;
  signal?: AbortSignal;
  onProgress?: (p: UpcomingRunProgress) => void;
  fetchImpl?: typeof fetch;
}): Promise<RunCheckUpcomingSuccess | RunCheckUpcomingFailure> {
  const pauseMs = options.pauseMs ?? UPCOMING_ADMIN_BATCH_PAUSE_MS;
  const maxBatches = options.maxBatches ?? UPCOMING_ADMIN_MAX_BATCHES;
  const fetchFn = options.fetchImpl ?? fetch;

  const totals: RunCheckUpcomingTotals = {
    alertsUpserted: 0,
    writesSkipped: 0,
    rowsChecked: 0,
  };

  let batches = 0;
  let last: CheckUpcomingApiBody = {};

  while (batches < maxBatches) {
    if (options.signal?.aborted) {
      return { ok: false, error: "Cancelled", batches, last };
    }

    const res = await fetchFn("/api/check-upcoming", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trigger: "manual" }),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    const raw = await res.text();
    let data: CheckUpcomingApiBody = {};
    try {
      data = raw ? (JSON.parse(raw) as CheckUpcomingApiBody) : {};
    } catch {
      return {
        ok: false,
        error: raw ? `Invalid JSON (${raw.slice(0, 120)}…)` : "Empty response",
        batches,
        last,
      };
    }

    last = data;
    batches += 1;
    options.onProgress?.({ batch: batches, last: data });

    if (!res.ok || data.ok === false) {
      return {
        ok: false,
        error: typeof data.error === "string" ? data.error : `Request failed (${res.status})`,
        batches,
        last: data,
      };
    }

    if (data.skipped) {
      return {
        ok: true as const,
        batches,
        skipped: true as const,
        reason: typeof data.reason === "string" ? data.reason : "skipped",
        totals,
        last: data,
      };
    }

    if (typeof data.alertsUpserted === "number") totals.alertsUpserted += data.alertsUpserted;
    if (typeof data.writesSkipped === "number") totals.writesSkipped += data.writesSkipped;
    if (typeof data.rowsChecked === "number") totals.rowsChecked += data.rowsChecked;

    if (data.completed === true) {
      return { ok: true as const, batches, skipped: false as const, totals, last: data };
    }

    if (data.completed !== false) {
      return {
        ok: false,
        error: "Unexpected response: expected completed true or false",
        batches,
        last: data,
      };
    }

    try {
      await sleepMs(pauseMs, options.signal);
    } catch (e) {
      if (isAbortError(e)) return { ok: false, error: "Cancelled", batches, last: data };
      throw e;
    }
  }

  return {
    ok: false,
    error: `Stopped after ${maxBatches} batches without completion`,
    batches,
    last,
  };
}
