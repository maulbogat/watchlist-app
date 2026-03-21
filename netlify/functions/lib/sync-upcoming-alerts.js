/**
 * Firestore sync for upcomingAlerts + shared TMDB logic entry points.
 */

const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { buildAlertsForCatalogRow, dedupeCatalogByTmdb } = require("./tmdb-upcoming-fetch");

const COLLECTION = "upcomingAlerts";
/** Admin-only cursor so Netlify can finish within ~30s per invocation. */
const SYNC_STATE_COLLECTION = "syncState";
const SYNC_STATE_DOC_ID = "upcomingAlerts";

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {object[]} alertPayloads - from buildAlertsForCatalogRow + finalizeAlert
 */
async function upsertAlerts(db, alertPayloads) {
  if (alertPayloads.length === 0) return;
  let batch = db.batch();
  let n = 0;
  for (const raw of alertPayloads) {
    const { docId, ...rest } = raw;
    const ref = db.collection(COLLECTION).doc(docId);
    batch.set(
      ref,
      {
        ...rest,
        detectedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
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
 * Remove alert docs for this catalog row that are no longer generated.
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
 * Delete expired alerts (expiresAt < today UTC date).
 */
async function deleteExpiredAlerts(db) {
  const today = new Date().toISOString().slice(0, 10);
  const snap = await db.collection(COLLECTION).where("expiresAt", "<", today).get();
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
 * @param {string} apiKey TMDB_API_KEY
 * @param {object[]} catalogItems - raw title rows (e.g. from titleRegistry); name kept for compatibility
 */
async function pruneAlertsOutsideCatalog(db, rows) {
  const valid = new Set(rows.map((r) => `${r.tmdbId}|${r.isTv ? "tv" : "movie"}`));
  const snap = await db.collection(COLLECTION).get();
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

async function runFullCatalogSync(db, apiKey, catalogItems) {
  const rows = dedupeCatalogByTmdb(Array.isArray(catalogItems) ? catalogItems : []);
  let upserted = 0;
  for (const row of rows) {
    const built = await buildAlertsForCatalogRow(apiKey, row);
    const ids = built.map((a) => a.docId);
    await deleteStaleAlertsForRow(db, row.tmdbId, row.isTv ? "tv" : "movie", ids);
    await upsertAlerts(db, built);
    upserted += built.length;
  }
  const pruned = await pruneAlertsOutsideCatalog(db, rows);
  const expiredRemoved = await deleteExpiredAlerts(db);
  return { rowsChecked: rows.length, alertsUpserted: upserted, pruned, expiredRemoved };
}

/**
 * Full sync from titleRegistry only (catalog/movies is deprecated).
 * Prefer **runRegistrySyncWithTimeBudget** on Netlify (30s limit).
 */
async function runFullRegistrySync(db, apiKey) {
  const regSnap = await db.collection("titleRegistry").get();
  const regItems = regSnap.docs.map((d) => d.data());
  return runFullCatalogSync(db, apiKey, regItems);
}

/**
 * Sync titleRegistry → upcomingAlerts in chunks that fit Netlify's ~30s limit.
 * Persists `nextIndex` in syncState/upcomingAlerts; run again until `completed: true`.
 * If titleRegistry doc count changes, cursor resets to 0.
 *
 * @param {number} maxMs stop starting new TMDB rows after this elapsed time (default 25s)
 */
async function runRegistrySyncWithTimeBudget(db, apiKey, maxMs = 25000) {
  const t0 = Date.now();
  let expiredRemoved = await deleteExpiredAlerts(db);

  const regSnap = await db.collection("titleRegistry").get();
  const regCount = regSnap.size;
  const regItems = regSnap.docs.map((d) => d.data());
  const rows = dedupeCatalogByTmdb(regItems);

  const stateRef = db.collection(SYNC_STATE_COLLECTION).doc(SYNC_STATE_DOC_ID);
  const stateSnap = await stateRef.get();
  let nextIndex = 0;
  if (stateSnap.exists) {
    const st = stateSnap.data();
    const prevCount = st.registryDocCount;
    if (prevCount === regCount && typeof st.nextIndex === "number" && st.nextIndex >= 0) {
      nextIndex = st.nextIndex;
    }
  }

  if (rows.length === 0) {
    await stateRef.set(
      {
        nextIndex: 0,
        registryDocCount: regCount,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return {
      rowsChecked: 0,
      alertsUpserted: 0,
      pruned: 0,
      expiredRemoved,
      completed: true,
      budgetMs: maxMs,
      elapsedMs: Date.now() - t0,
      message: "No titleRegistry rows with tmdbId to sync",
    };
  }

  let upserted = 0;
  let i = nextIndex;
  for (; i < rows.length; i++) {
    if (Date.now() - t0 > maxMs) break;
    const row = rows[i];
    const built = await buildAlertsForCatalogRow(apiKey, row);
    const ids = built.map((a) => a.docId);
    await deleteStaleAlertsForRow(db, row.tmdbId, row.isTv ? "tv" : "movie", ids);
    await upsertAlerts(db, built);
    upserted += built.length;
  }

  const completed = i >= rows.length;
  if (completed) {
    const pruned = await pruneAlertsOutsideCatalog(db, rows);
    expiredRemoved += await deleteExpiredAlerts(db);
    await stateRef.set(
      {
        nextIndex: 0,
        registryDocCount: regCount,
        lastCompletedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return {
      rowsChecked: rows.length,
      alertsUpserted: upserted,
      pruned,
      expiredRemoved,
      completed: true,
      budgetMs: maxMs,
      elapsedMs: Date.now() - t0,
    };
  }

  await stateRef.set(
    {
      nextIndex: i,
      registryDocCount: regCount,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return {
    rowsChecked: rows.length,
    alertsUpserted: upserted,
    pruned: 0,
    expiredRemoved,
    completed: false,
    nextIndex: i,
    totalRows: rows.length,
    budgetMs: maxMs,
    elapsedMs: Date.now() - t0,
    message: "Partial sync — click Run again (or wait for cron) until completed is true",
  };
}

/**
 * After adding one title with known TMDB id and media.
 * @param {'tv'|'movie'} media
 */
async function runSingleTitleSync(db, apiKey, tmdbId, media, titleHint) {
  const n = Number(tmdbId);
  if (Number.isNaN(n) || !apiKey) return { ok: false, error: "bad args" };
  const isTv = media === "tv";
  const row = { tmdbId: n, isTv, title: titleHint || "" };
  const built = await buildAlertsForCatalogRow(apiKey, row);
  const ids = built.map((a) => a.docId);
  await deleteStaleAlertsForRow(db, n, isTv ? "tv" : "movie", ids);
  await upsertAlerts(db, built);
  return { ok: true, count: built.length, docIds: ids };
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
