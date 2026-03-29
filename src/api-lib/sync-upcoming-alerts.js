/**
 * Firestore sync for **`upcomingAlerts`** + shared TMDB entry points (`buildAlertsForCatalogRow`).
 *
 * **Collections:**
 * - **`titleRegistry`** — read-only source of catalog rows (`tmdbId`, `tmdbMedia` / `type`).
 * - **`upcomingAlerts`** — upsert/delete alert documents keyed by deterministic `docId`.
 * - **`syncState/upcomingAlerts`** — resumable batch cursor for Netlify time limits.
 *
 * @module netlify/functions/lib/sync-upcoming-alerts
 */

/**
 * Client/shared TypeScript shape (subset enforced at write time).
 * @typedef {import('../types/index.js').UpcomingAlert} UpcomingAlert
 *
 * Firestore document fields for **`upcomingAlerts/{docId}`** (plus `detectedAt` server timestamp on write).
 * Aligns with {@link UpcomingAlert}; `airDate` stored as `YYYY-MM-DD` string; `expiresAt` ISO date string.
 *
 * @typedef {{
 *   fingerprint: string,
 *   catalogTmdbId: number,
 *   media: 'tv' | 'movie',
 *   tmdbId?: number,
 *   type?: 'tv' | 'movie',
 *   alertType: 'new_episode' | 'new_season' | 'upcoming_movie' | 'sequel',
 *   title: string,
 *   detail: string,
 *   airDate: string | null,
 *   confirmed: boolean,
 *   expiresAt?: string,
 *   sequelTmdbId?: number | null,
 *   detectedAt?: import('firebase-admin/firestore').FieldValue
 * }} UpcomingAlertFirestoreDoc
 *
 * Batch / cursor state at **`syncState/upcomingAlerts`** (document id `upcomingAlerts`).
 * @typedef {{
 *   lastRegistryDocId: string | null,
 *   registryDocCount?: number,
 *   nextIndex?: number,
 *   updatedAt?: import('firebase-admin/firestore').Timestamp,
 *   lastCompletedAt?: import('firebase-admin/firestore').Timestamp
 * }} UpcomingAlertsSyncStateDoc
 */

const { buildAlertsForCatalogRow, dedupeCatalogByTmdb } = require("./tmdb-upcoming-fetch");
const { createFunctionLogger } = require("./logger");

const logEvent = createFunctionLogger("sync-upcoming-alerts");

const COLLECTION = "upcomingAlerts";
/** Admin-only cursor so Netlify can finish within ~30s per invocation. */
const SYNC_STATE_COLLECTION = "syncState";
const SYNC_STATE_DOC_ID = "upcomingAlerts";
const UPCOMING_CHECKS_COLLECTION = "upcomingChecks";
/** Registry docs per Firestore query — avoids reading entire titleRegistry on every Netlify tick. */
const REGISTRY_PAGE_SIZE = 64;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {unknown} e
 * @returns {boolean}
 */
function isFirestoreQuotaError(e) {
  if (!e) return false;
  const code = e.code;
  if (code === 8 || code === "RESOURCE_EXHAUSTED") return true;
  const msg = String(e.message || e.details || "");
  return msg.includes("RESOURCE_EXHAUSTED") || msg.includes("Quota exceeded");
}

/**
 * @param {number} tmdbId
 * @param {'tv'|'movie'} media
 * @returns {string}
 */
function upcomingCheckDocId(tmdbId, media) {
  return `${tmdbId}_${media}`;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function toEpochMs(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {number} tmdbId
 * @param {'tv'|'movie'} media
 * @returns {Promise<{
 *   lastCheckedAt: string | null,
 *   lastCheckedAtMs: number | null,
 *   releaseDate: string | null,
 *   hasCollection: boolean | null,
 *   collectionId: number | null
 * }>}
 */
async function readUpcomingCheckState(db, tmdbId, media) {
  const docId = upcomingCheckDocId(tmdbId, media);
  const snap = await db
    .collection(UPCOMING_CHECKS_COLLECTION)
    .where("__name__", "==", docId)
    .select("lastCheckedAt", "releaseDate", "hasCollection", "collectionId")
    .limit(1)
    .get();
  if (snap.empty) {
    return {
      lastCheckedAt: null,
      lastCheckedAtMs: null,
      releaseDate: null,
      hasCollection: null,
      collectionId: null,
    };
  }
  const data = snap.docs[0]?.data() || {};
  const lastCheckedAt = typeof data.lastCheckedAt === "string" ? data.lastCheckedAt : null;
  const releaseDate = typeof data.releaseDate === "string" ? data.releaseDate : null;
  const hasCollection = typeof data.hasCollection === "boolean" ? data.hasCollection : null;
  const rawCollectionId = data.collectionId;
  const collectionId =
    rawCollectionId == null || rawCollectionId === "" || Number.isNaN(Number(rawCollectionId))
      ? null
      : Number(rawCollectionId);
  return {
    lastCheckedAt,
    lastCheckedAtMs: toEpochMs(lastCheckedAt),
    releaseDate,
    hasCollection,
    collectionId,
  };
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {number} tmdbId
 * @param {'tv'|'movie'} media
 * @param {{ releaseDate: string | null, hasCollection: boolean, collectionId: number | null } | null | undefined} movieMeta
 * @returns {Promise<void>}
 */
async function writeUpcomingCheckState(db, tmdbId, media, movieMeta) {
  const nowIso = new Date().toISOString();
  const payload = {
    tmdbId,
    media,
    lastCheckedAt: nowIso,
    updatedAt: nowIso,
    ...(media === "movie" && movieMeta
      ? {
          releaseDate: movieMeta.releaseDate ?? null,
          hasCollection: Boolean(movieMeta.hasCollection),
          collectionId: movieMeta.collectionId ?? null,
        }
      : {}),
  };
  const ref = db.collection(UPCOMING_CHECKS_COLLECTION).doc(upcomingCheckDocId(tmdbId, media));
  await ref.set(payload, { merge: true });
}

/**
 * @param {{
 *   lastCheckedAt: string | null,
 *   lastCheckedAtMs: number | null,
 *   releaseDate: string | null,
 *   hasCollection: boolean | null,
 *   collectionId: number | null
 * }} checkState
 * @returns {{ skip: boolean, caseLabel?: string, reason?: string }}
 */
function movieSkipDecision(checkState) {
  if (!checkState || !checkState.releaseDate || checkState.hasCollection == null) {
    return { skip: false };
  }
  const today = new Date().toISOString().slice(0, 10);
  // Case 1: unreleased movies are always checked.
  if (checkState.releaseDate > today) {
    return { skip: false };
  }
  if (checkState.hasCollection) {
    if (
      checkState.lastCheckedAtMs != null &&
      Date.now() - checkState.lastCheckedAtMs < THIRTY_DAYS_MS
    ) {
      return {
        skip: true,
        caseLabel: "case2_released_with_collection",
        reason: "checked within last 30 days",
      };
    }
    return { skip: false };
  }
  if (checkState.lastCheckedAtMs != null) {
    return {
      skip: true,
      caseLabel: "case3_released_no_collection",
      reason: "already checked once after release",
    };
  }
  return { skip: false };
}

/**
 * RESOURCE_EXHAUSTED (gRPC 8) often clears after a short wait — helps scheduled + overlapping runs.
 */
/**
 * @template T
 * @param {() => Promise<T>} fn
 * @param {string} [label]
 * @returns {Promise<T>}
 */
async function firestoreOpWithRetry(fn, label = "firestore") {
  const retries = 5;
  const baseMs = 2500;
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isFirestoreQuotaError(e) || attempt === retries - 1) throw e;
      const wait = baseMs * Math.pow(2, attempt);
      console.warn(
        `${label}: Firestore quota/transient, retry in ${wait}ms (${attempt + 1}/${retries}):`,
        e?.message || e
      );
      await sleep(wait);
    }
  }
  throw lastErr;
}

/**
 * @param {FirebaseFirestore.DocumentData} data
 * @returns {{ tmdbId: number, isTv: boolean, title: string } | null}
 */
function registryDocToRow(data) {
  if (!data || typeof data !== "object") return null;
  const t = data.tmdbId;
  if (t == null || t === "") return null;
  const n = Number(t);
  if (Number.isNaN(n)) return null;
  const isTv = data.tmdbMedia === "tv" || data.type === "show";
  return { tmdbId: n, isTv, title: data.title || "" };
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {string | null} afterDocId
 * @param {number} pageSize
 */
/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {string | null} afterDocId
 * @param {number} pageSize
 * @returns {Promise<FirebaseFirestore.QuerySnapshot>}
 */
async function fetchTitleRegistryPage(db, afterDocId, pageSize) {
  let q = db
    .collection("titleRegistry")
    .select("tmdbId", "tmdbMedia", "type", "title")
    .orderBy("__name__")
    .limit(pageSize);
  if (afterDocId) {
    const afterSnap = await db.collection("titleRegistry").doc(afterDocId).get();
    if (afterSnap.exists) q = q.startAfter(afterSnap);
  }
  return q.get();
}

/**
 * Paginate `titleRegistry` and collect `tmdbId|media` keys (for prune).
 * @param {FirebaseFirestore.Firestore} db
 * @returns {Promise<Set<string>>}
 */
async function collectRegistryTmdbKeys(db) {
  const valid = new Set();
  let lastId = null;
  while (true) {
    const page = await firestoreOpWithRetry(
      () => fetchTitleRegistryPage(db, lastId, 300),
      "collectRegistryTmdbKeys"
    );
    if (page.empty) break;
    for (const d of page.docs) {
      const row = registryDocToRow(d.data());
      if (row) valid.add(`${row.tmdbId}|${row.isTv ? "tv" : "movie"}`);
    }
    lastId = page.docs[page.docs.length - 1].id;
    if (page.size < 300) break;
  }
  return valid;
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {Array<UpcomingAlertFirestoreDoc & { docId: string }>} alertPayloads - from `buildAlertsForCatalogRow` (`docId` stripped before set)
 * @returns {Promise<{ written: number, skipped: number }>}
 */
async function upsertAlerts(db, alertPayloads) {
  const startedAt = Date.now();
  if (alertPayloads.length === 0) return { written: 0, skipped: 0 };
  function normalizeForCompare(raw) {
    return {
      fingerprint: raw.fingerprint ?? "",
      catalogTmdbId: raw.catalogTmdbId ?? null,
      media: raw.media ?? "",
      tmdbId: raw.tmdbId ?? null,
      type: raw.type ?? null,
      alertType: raw.alertType ?? "",
      title: raw.title ?? "",
      detail: raw.detail ?? "",
      airDate: raw.airDate ?? null,
      confirmed: Boolean(raw.confirmed),
      expiresAt: raw.expiresAt ?? null,
      sequelTmdbId: raw.sequelTmdbId ?? null,
    };
  }
  const refs = alertPayloads.map((raw) => db.collection(COLLECTION).doc(raw.docId));
  const existingSnaps = refs.length > 0 ? await db.getAll(...refs) : [];
  const existingById = new Map(existingSnaps.map((s) => [s.id, s]));
  let batch = db.batch();
  let n = 0;
  let written = 0;
  let skipped = 0;
  for (const raw of alertPayloads) {
    const { docId, ...rest } = raw;
    const ref = db.collection(COLLECTION).doc(docId);
    const currentSnap = existingById.get(docId);
    if (currentSnap?.exists) {
      const currentComparable = normalizeForCompare(currentSnap.data());
      const nextComparable = normalizeForCompare(rest);
      if (JSON.stringify(currentComparable) === JSON.stringify(nextComparable)) {
        skipped++;
        continue;
      }
    }
    batch.set(
      ref,
      {
        ...rest,
        detectedAt: new Date().toISOString(),
      },
      { merge: true }
    );
    n++;
    written++;
    if (n >= 400) {
      await batch.commit();
      batch = db.batch();
      n = 0;
    }
  }
  if (n > 0) await batch.commit();
  logEvent({
    type: "firestore.write",
    collection: COLLECTION,
    operation: "batch",
    written,
    skipped,
    durationMs: Date.now() - startedAt,
  });
  return { written, skipped };
}

/**
 * Remove `upcomingAlerts` docs for this catalog row that are no longer generated.
 * @param {FirebaseFirestore.Firestore} db
 * @param {number} catalogTmdbId
 * @param {'tv'|'movie'} media
 * @param {string[]} activeDocIds
 * @returns {Promise<void>}
 */
async function deleteStaleAlertsForRow(db, catalogTmdbId, media, activeDocIds) {
  const snap = await db
    .collection(COLLECTION)
    .where("catalogTmdbId", "==", catalogTmdbId)
    .where("media", "==", media)
    .get();
  const keep = new Set(activeDocIds);
  let batch = db.batch();
  let n = 0;
  for (const d of snap.docs) {
    if (keep.has(d.id)) continue;
    batch.delete(d.ref);
    n++;
    if (n >= 400) {
      await batch.commit();
      batch = db.batch();
      n = 0;
    }
  }
  if (n > 0) await batch.commit();
}

/**
 * Delete expired alerts (`expiresAt` &lt; today UTC date).
 * @param {FirebaseFirestore.Firestore} db
 * @returns {Promise<number>} deleted count
 */
async function deleteExpiredAlerts(db) {
  const today = new Date().toISOString().slice(0, 10);
  const snap = await db
    .collection(COLLECTION)
    .select("expiresAt")
    .where("expiresAt", "<", today)
    .get();
  if (snap.empty) return 0;
  let deleted = 0;
  let batch = db.batch();
  let n = 0;
  for (const d of snap.docs) {
    batch.delete(d.ref);
    n++;
    deleted++;
    if (n >= 400) {
      await batch.commit();
      batch = db.batch();
      n = 0;
    }
  }
  if (n > 0) await batch.commit();
  return deleted;
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {object[] | Set<string>} rowsOrSet - deduped catalog rows or precomputed `tmdbId|media` keys
 * @returns {Promise<number>} removed count
 */
async function pruneAlertsOutsideCatalog(db, rowsOrSet) {
  const valid =
    rowsOrSet instanceof Set
      ? rowsOrSet
      : new Set(
          (Array.isArray(rowsOrSet) ? rowsOrSet : []).map(
            (r) => `${r.tmdbId}|${r.isTv ? "tv" : "movie"}`
          )
        );
  const snap = await db.collection(COLLECTION).select("catalogTmdbId", "media").get();
  if (snap.empty) return 0;
  let removed = 0;
  let batch = db.batch();
  let n = 0;
  for (const d of snap.docs) {
    const data = d.data();
    const c = data.catalogTmdbId;
    const m = data.media;
    if (c == null || !m) continue;
    const k = `${c}|${m}`;
    if (valid.has(k)) continue;
    batch.delete(d.ref);
    n++;
    removed++;
    if (n >= 400) {
      await batch.commit();
      batch = db.batch();
      n = 0;
    }
  }
  if (n > 0) await batch.commit();
  return removed;
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} apiKey
 * @param {unknown[]} catalogItems
 * @returns {Promise<{ rowsChecked: number, alertsUpserted: number, pruned: number, expiredRemoved: number }>}
 */
async function runFullCatalogSync(db, apiKey, catalogItems) {
  const rows = dedupeCatalogByTmdb(Array.isArray(catalogItems) ? catalogItems : []);
  let upserted = 0;
  let writesSkipped = 0;
  for (const row of rows) {
    const builtResult = await buildAlertsForCatalogRow(apiKey, row, {
      onApiCall: ({ endpoint, tmdbId, status, durationMs }) => {
        logEvent({
          type: "api.call",
          service: "tmdb",
          endpoint,
          tmdbId,
          durationMs,
          status,
        });
      },
    });
    const built = builtResult.alerts;
    const ids = built.map((a) => a.docId);
    await deleteStaleAlertsForRow(db, row.tmdbId, row.isTv ? "tv" : "movie", ids);
    const upsertResult = await upsertAlerts(db, built);
    upserted += upsertResult.written;
    writesSkipped += upsertResult.skipped;
  }
  const pruned = await pruneAlertsOutsideCatalog(db, rows);
  const expiredRemoved = await deleteExpiredAlerts(db);
  return {
    rowsChecked: rows.length,
    alertsUpserted: upserted,
    writesSkipped,
    pruned,
    expiredRemoved,
  };
}

/**
 * Full sync from titleRegistry only (catalog/movies is deprecated).
 * Prefer **runRegistrySyncWithTimeBudget** on Netlify (30s limit).
 */
/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} apiKey
 * @returns {Promise<{ rowsChecked: number, alertsUpserted: number, pruned: number, expiredRemoved: number }>}
 */
async function runFullRegistrySync(db, apiKey) {
  const regSnap = await db
    .collection("titleRegistry")
    .select("tmdbId", "tmdbMedia", "type", "title")
    .get();
  const regItems = regSnap.docs.map((d) => d.data());
  return runFullCatalogSync(db, apiKey, regItems);
}

/**
 * Sync titleRegistry → upcomingAlerts in chunks that fit Netlify's ~30s limit.
 * Persists `lastRegistryDocId` in syncState/upcomingAlerts (Firestore doc id cursor).
 * Re-run until `completed: true`. Uses paginated registry reads (not a full collection .get())
 * to reduce Firestore reads and avoid RESOURCE_EXHAUSTED on Spark/free quotas.
 * Legacy `nextIndex` in syncState is ignored/cleared on first run after deploy.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} apiKey
 * @param {number} [maxMs] - Stop starting new registry rows / TMDB work after this elapsed wall time
 * @returns {Promise<Record<string, unknown>>} Partial or completed sync stats (`completed`, `rowsChecked`, …)
 */
async function runRegistrySyncWithTimeBudget(db, apiKey, maxMs = 25000) {
  const t0 = Date.now();
  const stateRef = db.collection(SYNC_STATE_COLLECTION).doc(SYNC_STATE_DOC_ID);
  const stateSnap = await firestoreOpWithRetry(() => stateRef.get(), "syncState.get");

  let regCount = null;
  try {
    const cntSnap = await firestoreOpWithRetry(
      () => db.collection("titleRegistry").count().get(),
      "titleRegistry.count"
    );
    regCount = cntSnap.data().count;
  } catch (e) {
    console.warn("titleRegistry.count() failed:", e?.message || e);
  }

  const st = stateSnap.exists ? stateSnap.data() : {};
  const lastPruneAtMs = toEpochMs(st.lastPruneAt);
  let lastRegistryDocId =
    typeof st.lastRegistryDocId === "string" && st.lastRegistryDocId.trim()
      ? st.lastRegistryDocId.trim()
      : null;

  if (typeof st.nextIndex === "number" && st.nextIndex > 0 && !st.lastRegistryDocId) {
    lastRegistryDocId = null;
  }

  if (
    regCount !== null &&
    typeof st.registryDocCount === "number" &&
    st.registryDocCount !== regCount
  ) {
    lastRegistryDocId = null;
  }

  let expiredRemoved = 0;
  if (lastRegistryDocId === null) {
    expiredRemoved = await firestoreOpWithRetry(
      () => deleteExpiredAlerts(db),
      "deleteExpiredAlerts"
    );
  }

  /**
   * @param {string | null} cursor
   * @returns {Promise<void>}
   */
  async function savePartial(cursor) {
    await firestoreOpWithRetry(
      () =>
        stateRef.set(
          {
            lastRegistryDocId: cursor,
            ...(regCount !== null ? { registryDocCount: regCount } : {}),
            nextIndex: null,
            updatedAt: new Date().toISOString(),
          },
          { merge: true }
        ),
      "syncState.set(partial)"
    );
  }

  let upserted = 0;
  let writesSkipped = 0;
  let rowsSkipped = 0;
  let persistCursor = lastRegistryDocId;
  let rowsVisited = 0;
  let scanComplete = false;

  outer: while (Date.now() - t0 < maxMs) {
    const pageSnap = await firestoreOpWithRetry(
      () => fetchTitleRegistryPage(db, persistCursor, REGISTRY_PAGE_SIZE),
      "titleRegistry.page"
    );

    if (pageSnap.empty) {
      if (persistCursor === null) {
        await firestoreOpWithRetry(
          () =>
            stateRef.set(
              {
                lastRegistryDocId: null,
                ...(regCount !== null ? { registryDocCount: regCount } : {}),
                nextIndex: null,
                updatedAt: new Date().toISOString(),
                lastCompletedAt: new Date().toISOString(),
              },
              { merge: true }
            ),
          "syncState.set(empty-registry)"
        );
        return {
          rowsChecked: 0,
          alertsUpserted: 0,
          writesSkipped: 0,
          pruned: 0,
          expiredRemoved,
          completed: true,
          totalRows: regCount,
          budgetMs: maxMs,
          elapsedMs: Date.now() - t0,
          message: "Empty titleRegistry",
        };
      }
      scanComplete = true;
      break outer;
    }

    for (const doc of pageSnap.docs) {
      if (Date.now() - t0 >= maxMs) {
        await savePartial(persistCursor);
        return {
          rowsChecked: rowsVisited,
          alertsUpserted: upserted,
          writesSkipped,
          rowsSkipped,
          pruned: 0,
          expiredRemoved,
          completed: false,
          lastRegistryDocId: persistCursor,
          totalRows: regCount,
          budgetMs: maxMs,
          elapsedMs: Date.now() - t0,
          message: "Partial sync — run again until completed is true",
        };
      }
      rowsVisited++;
      const row = registryDocToRow(doc.data());
      if (!row) {
        persistCursor = doc.id;
        continue;
      }
      const rowMedia = row.isTv ? "tv" : "movie";
      const checkState = await firestoreOpWithRetry(
        () => readUpcomingCheckState(db, row.tmdbId, rowMedia),
        "upcomingChecks.get"
      );
      if (rowMedia === "tv") {
        if (
          checkState.lastCheckedAtMs != null &&
          Date.now() - checkState.lastCheckedAtMs < SEVEN_DAYS_MS
        ) {
          rowsSkipped++;
          logEvent({
            type: "title.checked",
            tmdbId: row.tmdbId,
            media: rowMedia,
            skippedReason: "7d",
          });
          persistCursor = doc.id;
          continue;
        }
      } else {
        const decision = movieSkipDecision(checkState);
        if (decision.skip) {
          rowsSkipped++;
          const skippedReason =
            decision.caseLabel === "case2_released_with_collection"
              ? "30d"
              : decision.caseLabel === "case3_released_no_collection"
                ? "no-collection"
                : null;
          logEvent({
            type: "title.checked",
            tmdbId: row.tmdbId,
            media: rowMedia,
            skippedReason,
          });
          persistCursor = doc.id;
          continue;
        }
      }
      const builtResult = await buildAlertsForCatalogRow(apiKey, row, {
        onApiCall: ({ endpoint, tmdbId, status, durationMs }) => {
          logEvent({
            type: "api.call",
            service: "tmdb",
            endpoint,
            tmdbId,
            durationMs,
            status,
          });
        },
      });
      const built = builtResult.alerts;
      const ids = built.map((a) => a.docId);
      await firestoreOpWithRetry(
        () => deleteStaleAlertsForRow(db, row.tmdbId, rowMedia, ids),
        "deleteStaleAlertsForRow"
      );
      const upsertResult = await firestoreOpWithRetry(
        () => upsertAlerts(db, built),
        "upsertAlerts"
      );
      upserted += upsertResult.written;
      writesSkipped += upsertResult.skipped;
      await firestoreOpWithRetry(
        () => writeUpcomingCheckState(db, row.tmdbId, rowMedia, builtResult.movieCheckMeta),
        "upcomingChecks.set"
      );
      logEvent({
        type: "title.checked",
        tmdbId: row.tmdbId,
        media: rowMedia,
        skippedReason: null,
      });
      persistCursor = doc.id;
    }

    if (pageSnap.size < REGISTRY_PAGE_SIZE) {
      scanComplete = true;
      break outer;
    }
  }

  if (!scanComplete) {
    await savePartial(persistCursor);
    return {
      rowsChecked: rowsVisited,
      alertsUpserted: upserted,
      writesSkipped,
      rowsSkipped,
      pruned: 0,
      expiredRemoved,
      completed: false,
      lastRegistryDocId: persistCursor,
      totalRows: regCount,
      budgetMs: maxMs,
      elapsedMs: Date.now() - t0,
      message: "Partial sync — run again until completed is true",
    };
  }

  let pruned = 0;
  const shouldRunPrune = lastPruneAtMs == null || Date.now() - lastPruneAtMs >= SEVEN_DAYS_MS;
  if (shouldRunPrune) {
    const pruneStartedAt = Date.now();
    const validKeys = await collectRegistryTmdbKeys(db);
    if (validKeys.size > 0 || regCount === 0) {
      pruned = await firestoreOpWithRetry(
        () => pruneAlertsOutsideCatalog(db, validKeys),
        "pruneAlertsOutsideCatalog"
      );
      logEvent({
        type: "prune.run",
        deleted: pruned,
        durationMs: Date.now() - pruneStartedAt,
      });
    } else {
      console.warn(
        "sync-upcoming-alerts: skipping prune — titleRegistry has docs but none with tmdbId (would clear all alerts)"
      );
      logEvent({
        type: "prune.skipped",
        lastPruneAt: st.lastPruneAt || null,
      });
    }
  } else {
    logEvent({
      type: "prune.skipped",
      lastPruneAt: st.lastPruneAt || null,
    });
  }

  const nowIso = new Date().toISOString();
  await firestoreOpWithRetry(
    () =>
      stateRef.set(
        {
          lastRegistryDocId: null,
          ...(regCount !== null ? { registryDocCount: regCount } : {}),
          nextIndex: null,
          ...(shouldRunPrune ? { lastPruneAt: nowIso } : {}),
          lastCompletedAt: nowIso,
          updatedAt: nowIso,
        },
        { merge: true }
      ),
    "syncState.set(complete)"
  );

  return {
    rowsChecked: rowsVisited,
    alertsUpserted: upserted,
    writesSkipped,
    rowsSkipped,
    pruned,
    expiredRemoved,
    completed: true,
    totalRows: regCount,
    budgetMs: maxMs,
    elapsedMs: Date.now() - t0,
  };
}

/**
 * After adding one title with known TMDB id and media (bookmarklet path).
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} apiKey
 * @param {number|string} tmdbId
 * @param {'tv'|'movie'} media
 * @param {string} [titleHint]
 * @returns {Promise<{ ok: boolean, error?: string, count?: number, docIds?: string[] }>}
 */
async function runSingleTitleSync(db, apiKey, tmdbId, media, titleHint) {
  const n = Number(tmdbId);
  if (Number.isNaN(n) || !apiKey) return { ok: false, error: "bad args" };
  const isTv = media === "tv";
  const row = { tmdbId: n, isTv, title: titleHint || "" };
  const builtResult = await buildAlertsForCatalogRow(apiKey, row, {
    onApiCall: ({ endpoint, tmdbId, status, durationMs }) => {
      logEvent({
        type: "api.call",
        service: "tmdb",
        endpoint,
        tmdbId,
        durationMs,
        status,
      });
    },
  });
  const built = builtResult.alerts;
  const ids = built.map((a) => a.docId);
  await deleteStaleAlertsForRow(db, n, isTv ? "tv" : "movie", ids);
  const upsertResult = await upsertAlerts(db, built);
  return { ok: true, count: upsertResult.written, skipped: upsertResult.skipped, docIds: ids };
}

module.exports = {
  COLLECTION,
  SYNC_STATE_COLLECTION,
  SYNC_STATE_DOC_ID,
  upsertAlerts,
  deleteStaleAlertsForRow,
  deleteExpiredAlerts,
  runFullCatalogSync,
  runFullRegistrySync,
  runRegistrySyncWithTimeBudget,
  runSingleTitleSync,
  dedupeCatalogByTmdb,
  buildAlertsForCatalogRow,
};
