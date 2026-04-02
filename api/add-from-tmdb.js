/**
 * Vercel serverless function: **add-from-tmdb**
 *
 * **Trigger:** HTTP `POST`. Called from the TrailerModal when the user adds a recommended title.
 * Authenticates via Firebase ID token in the `Authorization: Bearer` header.
 *
 * **Input body:** `{ tmdbId: number, mediaType: "movie"|"tv", listId: string, listType: "personal"|"shared" }`
 *
 * **Steps:**
 * 1. Verify Firebase ID token → uid.
 * 2. Check `titleRegistry` for an existing doc with this `tmdbId` — reuse it if found.
 * 3. If no existing doc: fetch TMDB details + external_ids + videos + watch/providers (IL region).
 * 4. Build and write a `titleRegistry/{registryId}` doc (same shape as `add-from-imdb.js`).
 * 5. Add `{ registryId, addedAt }` row to the target list (shared or personal).
 * 6. Trigger upcoming-alerts sync for the title.
 * 7. Return `{ registryId, title }`.
 *
 * **Firestore writes:**
 * - `titleRegistry/{registryId}` — `set(merge)` when no existing doc matched.
 * - `sharedLists/{listId}` or `users/{uid}/personalLists/{listId}` — items array updated.
 * - `upcomingAlerts` — optional upsert via `runSingleTitleSync`.
 */

const { initializeApp, cert, getApps, getApp: getAdminApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

const https = require("https");
const { runSingleTitleSync } = require("../src/api-lib/sync-upcoming-alerts");
const { payloadForRegistry } = require("../src/api-lib/registry-id.cjs");
const { createFunctionLogger } = require("../src/api-lib/logger");
const { checkFirestoreQuota, QuotaExceededError } = require("../src/api-lib/firestore-guard");
const { captureException } = require("../src/api-lib/sentry-node.js");
const { wrapNetlifyHandler } = require("../src/api-lib/vercel-adapter");

const logEvent = createFunctionLogger("add-from-tmdb");

const APP_NAME = "watchlist-admin";
const YOUTUBE_VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
const TMDB_IMG = "https://image.tmdb.org/t/p/w500";
const WATCH_REGION = "IL";

function getApp() {
  if (global.__watchlistAdminApp) return global.__watchlistAdminApp;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT not set");
  const key = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
  const existing = getApps().find((a) => a.name === APP_NAME);
  const app = existing || initializeApp({ credential: cert(key), projectId: key.project_id }, APP_NAME);
  global.__watchlistAdminApp = app;
  return app;
}

/**
 * @param {string} url
 * @returns {Promise<unknown>}
 */
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

/**
 * @param {unknown} results
 * @returns {string | null}
 */
function pickYoutubeTrailerKey(results) {
  const r = results || [];
  const preferred = (t) => r.find((v) => v.site === "YouTube" && v.key && v.type === t);
  const key =
    preferred("Trailer") ||
    preferred("Teaser") ||
    r.find((v) => v.site === "YouTube" && v.key && (v.type === "Clip" || v.type === "Featurette")) ||
    r.find((v) => v.site === "YouTube" && v.key);
  return key?.key || null;
}

/**
 * @param {number} status
 * @param {Record<string, unknown>} body
 * @param {import('@netlify/functions').HandlerEvent} event
 * @returns {import('@netlify/functions').HandlerResponse}
 */
function jsonRes(status, body, event) {
  const origin = event.headers?.origin || event.headers?.Origin || "*";
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
    body: JSON.stringify(body),
  };
}

/**
 * Core logic: fetch TMDB metadata (or reuse existing registry doc), write registry, add to list.
 *
 * @param {string} uid
 * @param {number} tmdbId
 * @param {"movie" | "tv"} mediaType
 * @param {string} listId
 * @param {"personal" | "shared"} listType
 * @returns {Promise<{ statusCode: number, body: Record<string, unknown> }>}
 */
async function performAddFromTmdb(uid, tmdbId, mediaType, listId, listType) {
  const db = getFirestore(getApp());

  try {
    await checkFirestoreQuota(db, 8);
  } catch (e) {
    if (e instanceof QuotaExceededError) {
      logEvent({ type: "quota.exceeded", period: e.period, function: "add-from-tmdb" });
      return { statusCode: 503, body: { ok: false, error: "quota_exceeded", period: e.period } };
    }
    throw e;
  }

  const tmdbKey = process.env.TMDB_API_KEY;
  if (!tmdbKey) {
    return { statusCode: 500, body: { ok: false, error: "TMDB not configured on server" } };
  }

  // Step 1: Check for an existing titleRegistry doc with this tmdbId
  const existingSnap = await db.collection("titleRegistry").where("tmdbId", "==", tmdbId).limit(1).get();

  let registryId;
  /** @type {Record<string, unknown>} */
  let movie;

  if (!existingSnap.empty) {
    // Reuse existing registry entry — no TMDB call needed
    const existingDoc = existingSnap.docs[0];
    registryId = existingDoc.id;
    movie = existingDoc.data();
    logEvent({ type: "registry.reused", tmdbId, registryId, title: movie.title });
  } else {
    // Step 2: Fetch TMDB detail + videos + external_ids
    const detailUrl = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?append_to_response=videos,external_ids&api_key=${tmdbKey}`;
    const detailStart = Date.now();
    const detail = await fetchJson(detailUrl);
    logEvent({ type: "api.call", service: "tmdb", endpoint: "/detail+videos+external_ids", tmdbId, durationMs: Date.now() - detailStart });

    // Step 3: Fetch watch providers separately (same pattern as add-from-imdb.js)
    const providersUrl = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}/watch/providers?api_key=${tmdbKey}`;
    const pdata = await fetchJson(providersUrl);
    const regionProviders = pdata.results?.[WATCH_REGION];
    const services = [];
    if (regionProviders) {
      const seen = new Set();
      for (const arr of [regionProviders.flatrate, regionProviders.rent, regionProviders.buy].filter(Boolean)) {
        for (const p of arr) {
          if (p.provider_name && !seen.has(p.provider_name)) {
            seen.add(p.provider_name);
            services.push(p.provider_name);
          }
        }
      }
    }

    const posterPath = detail.poster_path;
    const thumb = posterPath ? `${TMDB_IMG}${posterPath}` : null;

    const title =
      mediaType === "movie"
        ? detail.title || detail.original_title || "Unknown"
        : detail.name || detail.original_name || "Unknown";

    let year = null;
    const dateStr = mediaType === "movie" ? detail.release_date : detail.first_air_date;
    if (dateStr && String(dateStr).length >= 4) {
      year = parseInt(String(dateStr).slice(0, 4), 10);
      if (Number.isNaN(year)) year = null;
    }

    const genres = (detail.genres || []).map((g) => g.name).filter(Boolean);
    const genre = genres.join(" / ");

    const olRaw = detail.original_language;
    const originalLanguage =
      typeof olRaw === "string" && olRaw.trim() ? String(olRaw).trim().toLowerCase() : null;

    const youtubeKey = pickYoutubeTrailerKey(detail.videos?.results);
    const youtubeId = youtubeKey && YOUTUBE_VIDEO_ID_RE.test(youtubeKey) ? youtubeKey : null;

    // Normalize imdbId from external_ids
    const imdbRaw = detail.external_ids?.imdb_id;
    let imdbId = null;
    if (imdbRaw && typeof imdbRaw === "string" && imdbRaw.trim()) {
      imdbId = imdbRaw.startsWith("tt") ? imdbRaw : `tt${imdbRaw}`;
    }

    // registryId: prefer imdbId (stable), else tmdb-{type}-{id}
    registryId = imdbId || (mediaType === "tv" ? `tmdb-tv-${tmdbId}` : `tmdb-movie-${tmdbId}`);

    movie = {
      title,
      year,
      type: mediaType === "tv" ? "show" : "movie",
      tmdbMedia: mediaType,
      tmdbId,
      imdbId,
      genre,
      thumb,
      youtubeId,
      services,
      ...(originalLanguage ? { originalLanguage } : {}),
    };

    // Write titleRegistry doc (merge — safe for concurrent adds)
    const regRef = db.collection("titleRegistry").doc(registryId);
    const payload = payloadForRegistry({ ...movie, registryId });
    await regRef.set(payload, { merge: true });
    logEvent({ type: "firestore.write", collection: "titleRegistry", operation: "set", registryId });
  }

  // Step 4: Add registryId row to the target list
  const addedAt = new Date().toISOString();

  if (listType === "shared") {
    const listRef = db.collection("sharedLists").doc(listId);
    const listSnap = await listRef.get();
    if (!listSnap.exists) {
      return { statusCode: 404, body: { ok: false, error: "Shared list not found" } };
    }
    const listData = listSnap.data();
    const members = Array.isArray(listData.members) ? listData.members : [];
    if (!members.includes(uid)) {
      return { statusCode: 403, body: { ok: false, error: "Not a member of this shared list" } };
    }

    // Check for duplicate
    const items = Array.isArray(listData.items) ? listData.items : [];
    if (items.some((row) => row && row.registryId === registryId)) {
      return {
        statusCode: 200,
        body: { ok: true, added: false, registryId, title: movie.title, message: `"${movie.title}" is already in this list` },
      };
    }

    // Fetch user display info for denormalization
    let addedByDisplayName = null;
    let addedByPhotoUrl = null;
    try {
      const authAdmin = getAuth(getApp());
      const u = await authAdmin.getUser(uid);
      addedByDisplayName =
        (u.displayName && String(u.displayName).trim()) ||
        (u.email ? String(u.email).split("@")[0] : null) ||
        null;
      addedByPhotoUrl = (u.photoURL && String(u.photoURL).trim()) || null;
    } catch {
      /* ignore profile sync errors */
    }

    const newRow = {
      registryId,
      addedAt,
      addedByUid: uid,
      ...(addedByDisplayName ? { addedByDisplayName } : {}),
      ...(addedByPhotoUrl ? { addedByPhotoUrl } : {}),
    };
    await listRef.set({ items: [...items, newRow] }, { merge: true });
  } else {
    // Personal list
    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    const uData = userSnap.exists ? userSnap.data() : {};

    // Resolve real personal list id (listId may be "personal" alias)
    let targetPlId = listId;
    if (listId === "personal") {
      targetPlId =
        typeof uData.defaultPersonalListId === "string" ? uData.defaultPersonalListId.trim() : "";
      if (!targetPlId) {
        return {
          statusCode: 400,
          body: { ok: false, error: "No personal list found. Open the app and set up a list first." },
        };
      }
    }

    const plRef = userRef.collection("personalLists").doc(targetPlId);
    const plSnap = await plRef.get();
    if (!plSnap.exists) {
      return { statusCode: 404, body: { ok: false, error: "Personal list not found" } };
    }
    const plData = plSnap.data();
    const items = Array.isArray(plData.items) ? plData.items : [];

    // Check for duplicate
    if (items.some((row) => row && row.registryId === registryId)) {
      return {
        statusCode: 200,
        body: { ok: true, added: false, registryId, title: movie.title, message: `"${movie.title}" is already in your list` },
      };
    }

    await plRef.set({ items: [...items, { registryId, addedAt }] }, { merge: true });
  }

  logEvent({ type: "title.added", tmdbId, title: movie.title, listType, registryId });

  // Step 5: Sync upcoming alerts
  try {
    await runSingleTitleSync(db, tmdbKey, tmdbId, mediaType, movie.title);
  } catch (e) {
    console.warn("upcomingAlerts sync:", e?.message || e);
  }

  return {
    statusCode: 200,
    body: { ok: true, added: true, registryId, title: movie.title },
  };
}

/**
 * @param {import('@netlify/functions').HandlerEvent} event
 * @returns {Promise<import('@netlify/functions').HandlerResponse>}
 */
exports.handler = async (event) => {
  try {
    logEvent({ type: "function.invoked", trigger: "rec-add" });

    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" } };
    }

    if (event.httpMethod !== "POST") {
      return jsonRes(405, { ok: false, error: "Method not allowed" }, event);
    }

    // Verify Firebase ID token
    const token = (event.headers?.authorization || "").replace(/^Bearer\s+/i, "").trim();
    if (!token) {
      return jsonRes(401, { ok: false, error: "Authorization token required" }, event);
    }

    let uid;
    try {
      const decoded = await getAuth(getApp()).verifyIdToken(token);
      uid = decoded.uid;
    } catch {
      return jsonRes(401, { ok: false, error: "Invalid or expired token. Sign in again." }, event);
    }

    let body;
    try {
      body = typeof event.body === "string" ? JSON.parse(event.body) : event.body || {};
    } catch {
      return jsonRes(400, { ok: false, error: "Invalid JSON body" }, event);
    }

    const { tmdbId, mediaType, listId, listType } = body;

    if (!tmdbId || typeof tmdbId !== "number") {
      return jsonRes(400, { ok: false, error: "tmdbId (number) required" }, event);
    }
    if (mediaType !== "movie" && mediaType !== "tv") {
      return jsonRes(400, { ok: false, error: 'mediaType must be "movie" or "tv"' }, event);
    }
    if (!listId || typeof listId !== "string") {
      return jsonRes(400, { ok: false, error: "listId (string) required" }, event);
    }
    if (listType !== "personal" && listType !== "shared") {
      return jsonRes(400, { ok: false, error: 'listType must be "personal" or "shared"' }, event);
    }

    const result = await performAddFromTmdb(uid, tmdbId, mediaType, listId, listType);
    return jsonRes(result.statusCode, result.body, event);
  } catch (err) {
    captureException(err);
    const msg =
      err && typeof err === "object" && "message" in err ? String(err.message) : String(err || "Unexpected error");
    console.error("add-from-tmdb fatal:", err);
    logEvent({ type: "function.error", error: msg });
    return jsonRes(500, { ok: false, error: msg }, event);
  }
};

const vercelHandler = wrapNetlifyHandler(exports.handler);
module.exports = vercelHandler;
