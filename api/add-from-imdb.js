/**
 * Netlify serverless function: **add-from-imdb**
 *
 * **Trigger:** HTTP `POST` (CORS + `OPTIONS`). Called from the bookmarklet and `/add` flow.
 * Authenticates via Firebase ID token in the `bookmarklet_token` cookie or `Authorization: Bearer`.
 *
 * **Firestore writes:**
 * - **`titleRegistry/{registryId}`** — `set(merge)` with TMDB/OMDb-enriched fields (via `payloadForRegistry`).
 * - **`sharedLists/{listId}`** — when `listId` is present and user is a member: updates `items`, `watched`,
 *   `maybeLater`, `archive` (registry ref rows + status keys).
 * - **`users/{uid}`** + **`users/{uid}/personalLists/{id}`** — default path: may run legacy migration on `users/{uid}`,
 *   then merges the target personal list subdocument.
 * - **`upcomingAlerts`** — optional upsert via `runSingleTitleSync` when a TMDB id is available.
 *
 * @module netlify/functions/add-from-imdb
 */

/**
 * Shared domain types (client/Firestore shapes). Netlify functions are plain JS; these imports are for JSDoc only.
 *
 * @typedef {import('../../src/types/index.js').WatchlistItem} WatchlistItem
 * @typedef {import('../../src/types/index.js').SharedList} SharedList
 * @typedef {import('../../src/types/index.js').UserProfile} UserProfile
 *
 * POST JSON body (also reads cookies: `bookmarklet_token`, `bookmarklet_list_id`, `bookmarklet_personal_list_id`).
 * @typedef {{
 *   imdbId: string,
 *   listId?: string,
 *   personalListId?: string,
 *   watch_region?: string,
 *   watchRegion?: string
 * }} AddFromImdbBody
 *
 * Success when the title was added or merged into the list.
 * @typedef {{ ok: true, added: true, message: string }} AddFromImdbAdded
 *
 * Success when the title is already on the list (non–to-watch status).
 * @typedef {{ ok: true, added: false, message: string }} AddFromImdbDuplicate
 * @typedef {AddFromImdbAdded | AddFromImdbDuplicate} AddFromImdbSuccess
 *
 * Error response (4xx/5xx).
 * @typedef {{ ok: false, error: string }} AddFromImdbError
 */

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

const APP_NAME = "watchlist-admin";
const https = require("https");
const { runSingleTitleSync } = require("../src/api-lib/sync-upcoming-alerts");
const { registryDocIdFromItem, payloadForRegistry, listKey } = require("../src/api-lib/registry-id.cjs");
const { createFunctionLogger } = require("../src/api-lib/logger");
const { checkFirestoreQuota, QuotaExceededError } = require("../src/api-lib/firestore-guard");
const { captureException } = require("../src/api-lib/sentry-node.js");

const logEvent = createFunctionLogger("add-from-imdb");

/** Same rule as lib/youtube-trailer-id.js (YouTube video id from TMDB). */
const YOUTUBE_VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

/**
 * @param {unknown} v
 * @returns {string | null}
 */
function normalizeStoredYoutubeTrailerId(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  if (!YOUTUBE_VIDEO_ID_RE.test(s)) return null;
  return s;
}

/**
 * @param {unknown} v
 * @returns {boolean}
 */
function isPlayableYoutubeTrailerId(v) {
  if (v == null || typeof v !== "string") return false;
  return YOUTUBE_VIDEO_ID_RE.test(v.trim());
}

/**
 * Lazily initializes Firebase Admin (service account from `FIREBASE_SERVICE_ACCOUNT` base64 JSON).
 * @returns {import('firebase-admin/app').App}
 */
function getApp() {
  if (global.__watchlistAdminApp) return global.__watchlistAdminApp;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT not set");
  const key = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
  const app = initializeApp({ credential: cert(key), projectId: key.project_id }, APP_NAME);
  global.__watchlistAdminApp = app;
  return app;
}

/**
 * CORS headers reflecting the request `Origin`.
 * @param {import('@netlify/functions').HandlerEvent} event
 * @returns {Record<string, string>}
 */
function corsHeaders(event) {
  const origin = event.headers?.origin || event.headers?.Origin || "*";
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

/**
 * @param {number} status
 * @param {AddFromImdbSuccess | AddFromImdbError | Record<string, unknown>} body
 * @param {import('@netlify/functions').HandlerEvent} event
 * @returns {import('@netlify/functions').HandlerResponse}
 */
function jsonRes(status, body, event) {
  return {
    statusCode: status,
    headers: corsHeaders(event),
    body: JSON.stringify(body),
  };
}

/**
 * Convert backend errors to user-facing messages.
 * @param {unknown} err
 * @returns {string}
 */
function presentableErrorMessage(err) {
  const raw =
    err && typeof err === "object" && "message" in err
      ? String(err.message || "")
      : String(err || "");
  if (/RESOURCE_EXHAUSTED|quota exceeded/i.test(raw)) {
    return "Firestore quota exceeded for this project. Please try again later or increase Firebase quota/billing.";
  }
  if (/deadline exceeded|timed out/i.test(raw)) {
    return "Request timed out while updating watchlist. Please try again.";
  }
  return raw || "Unexpected error";
}

/**
 * @param {string} imdbId
 * @returns {Promise<Record<string, unknown>>}
 */
function fetchOMDb(imdbId) {
  const apiKey = process.env.OMDB_API_KEY;
  if (!apiKey) return Promise.reject(new Error("OMDB_API_KEY not set in Netlify environment"));
  const url = `https://www.omdbapi.com/?i=${encodeURIComponent(imdbId)}&apikey=${apiKey}`;
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.Response === "False") {
            reject(new Error(json.Error || "OMDb lookup failed"));
          } else {
            resolve(json);
          }
        } catch (e) {
          reject(e);
        }
      });
    }).on("error", reject);
  });
}

/**
 * @param {string} url
 * @returns {Promise<unknown>}
 */
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on("error", reject);
  });
}

const TMDB_IMG = "https://image.tmdb.org/t/p/w500";

/**
 * @param {unknown} results
 * @returns {string | null}
 */
function pickYoutubeTrailerKey(results) {
  const r = results || [];
  const preferred = (t) =>
    r.find((v) => v.site === "YouTube" && v.key && v.type === t);
  const key =
    preferred("Trailer") ||
    preferred("Teaser") ||
    r.find((v) => v.site === "YouTube" && v.key && (v.type === "Clip" || v.type === "Featurette")) ||
    r.find((v) => v.site === "YouTube" && v.key);
  return key?.key || null;
}

/**
 * When TMDB returns both a movie and TV hit for one IMDb id, we must pick one.
 * Bugfix: `movie?.id ?? tv?.id` always preferred movie — wrong for TV miniseries (e.g. Cecil Hotel
 * could get another title's trailer/thumb/genres). Use OMDb Type when available; else prefer TV
 * when both exist (miniseries/docuseries are usually TV on TMDB).
 * @param {Record<string, unknown>} find - TMDB `/find` JSON
 * @param {object | null} omdbHint - OMDb row `{ Type, Title }` if already fetched
 * @returns {{ mediaType: 'tv' | 'movie' | null, id: number | null }}
 */
function pickTmdbFindEntry(find, omdbHint) {
  const movie = find.movie_results?.[0];
  const tv = find.tv_results?.[0];
  if (!movie && !tv) return { mediaType: null, id: null };
  if (!movie) return { mediaType: "tv", id: tv.id };
  if (!tv) return { mediaType: "movie", id: movie.id };

  const t = omdbHint && String(omdbHint.Type || "").toLowerCase();
  if (t === "movie") return { mediaType: "movie", id: movie.id };
  if (t === "series" || t === "episode") return { mediaType: "tv", id: tv.id };
  // No OMDb or ambiguous: prefer TV so we don't attach a random film's trailer to a series id
  return { mediaType: "tv", id: tv.id };
}

/**
 * Full TMDB enrichment from IMDb id: type, title, year, poster, genres, trailer key, watch providers.
 * Returns null if TMDB has no match for this IMDb id.
 *
 * @param {string} imdbId
 * @param {string} apiKey
 * @param {string} watchRegion - ISO 3166-1 alpha-2 region for watch providers
 * @param {object | null} omdbHint
 * @returns {Promise<{
 *   tmdbId: number,
 *   type: 'movie' | 'show',
 *   title: string,
 *   year: number | null,
 *   thumb: string | null,
 *   genre: string,
 *   youtubeId: string | null,
 *   services: string[],
 *   originalLanguage: string | null
 * } | null>}
 */
async function enrichFromTmdb(imdbId, apiKey, watchRegion, omdbHint, options = {}) {
  const onApiCall = typeof options.onApiCall === "function" ? options.onApiCall : null;
  const findUrl = `https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}?external_source=imdb_id&api_key=${apiKey}`;
  const findStart = Date.now();
  const find = await fetchJson(findUrl);
  if (onApiCall) {
    try {
      onApiCall({
        endpoint: "/find",
        imdbId,
        durationMs: Date.now() - findStart,
        status: 200,
      });
    } catch {
      // observability must never break flow
    }
  }
  const { mediaType, id } = pickTmdbFindEntry(find, omdbHint);
  if (id == null || !mediaType) return null;

  const detailUrl = `https://api.themoviedb.org/3/${mediaType}/${id}?append_to_response=videos&api_key=${apiKey}`;
  const detail = await fetchJson(detailUrl);

  const posterPath = detail.poster_path;
  const thumb = posterPath ? `${TMDB_IMG}${posterPath}` : null;

  const title =
    mediaType === "movie"
      ? detail.title || detail.original_title || ""
      : detail.name || detail.original_name || "";

  let year = null;
  if (mediaType === "movie") {
    const d = detail.release_date;
    if (d && String(d).length >= 4) year = parseInt(String(d).slice(0, 4), 10);
  } else {
    const d = detail.first_air_date;
    if (d && String(d).length >= 4) year = parseInt(String(d).slice(0, 4), 10);
  }
  if (Number.isNaN(year)) year = null;

  const genres = (detail.genres || []).map((g) => g.name).filter(Boolean);
  const genre = genres.join(" / ");

  const olRaw = detail.original_language;
  const originalLanguage =
    typeof olRaw === "string" && olRaw.trim() ? String(olRaw).trim().toLowerCase() : null;

  const youtubeId = pickYoutubeTrailerKey(detail.videos?.results);

  let services = [];
  if (watchRegion && String(watchRegion).length >= 2) {
    const providersUrl = `https://api.themoviedb.org/3/${mediaType}/${id}/watch/providers?api_key=${apiKey}`;
    const pdata = await fetchJson(providersUrl);
    const region = pdata.results?.[String(watchRegion).toUpperCase().slice(0, 2)];
    if (region) {
      const names = new Set();
      for (const arr of [region.flatrate, region.rent, region.buy].filter(Boolean)) {
        for (const p of arr) {
          if (p.provider_name) names.add(p.provider_name);
        }
      }
      services = [...names];
    }
  }

  return {
    tmdbId: id,
    type: mediaType === "movie" ? "movie" : "show",
    title: title || "Unknown",
    year,
    thumb,
    genre,
    youtubeId,
    services,
    originalLanguage,
  };
}

/**
 * @returns {string}
 */
function adminRandomListId() {
  return Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function normalizeAddedAt(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

/**
 * @param {string} registryId
 * @param {Record<string, unknown> | null | undefined} existingRow
 * @param {{
 *   addedByUid?: string;
 *   addedByDisplayName?: string | null;
 *   addedByPhotoUrl?: string | null;
 * } | null | undefined} addedBy
 * @returns {{ registryId: string, addedAt: string } & Record<string, unknown>}
 */
function toStoredRegistryRef(registryId, existingRow, addedBy) {
  const keepExisting = normalizeAddedAt(existingRow?.addedAt);
  const out = {
    registryId,
    addedAt: keepExisting || new Date().toISOString(),
  };
  const prevUid =
    existingRow && typeof existingRow.addedByUid === "string" ? existingRow.addedByUid : null;
  if (prevUid) {
    out.addedByUid = prevUid;
    const prevDn = existingRow && typeof existingRow.addedByDisplayName === "string" ? existingRow.addedByDisplayName.trim() : "";
    if (prevDn) out.addedByDisplayName = prevDn;
    const prevPhoto = existingRow && typeof existingRow.addedByPhotoUrl === "string" ? existingRow.addedByPhotoUrl.trim() : "";
    if (prevPhoto) out.addedByPhotoUrl = prevPhoto;
  } else if (addedBy && typeof addedBy.addedByUid === "string") {
    out.addedByUid = addedBy.addedByUid;
    const dn = typeof addedBy.addedByDisplayName === "string" ? addedBy.addedByDisplayName.trim() : "";
    if (dn) out.addedByDisplayName = dn;
    const photo = typeof addedBy.addedByPhotoUrl === "string" ? addedBy.addedByPhotoUrl.trim() : "";
    if (photo) out.addedByPhotoUrl = photo;
  }
  return out;
}

/**
 * Mirror client migrate: move legacy `users/{uid}.items` → `users/{uid}/personalLists/{id}`.
 * @param {import('firebase-admin/firestore').Firestore} db
 * @param {string} uid
 * @returns {Promise<void>}
 */
async function migrateLegacyPersonalListAdmin(db, uid) {
  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) return;
  const data = userSnap.data() || {};

  let defId = typeof data.defaultPersonalListId === "string" ? data.defaultPersonalListId.trim() : "";
  if (defId) {
    const plSnap = await userRef.collection("personalLists").doc(defId).get();
    if (plSnap.exists) return;
    await userRef.update({ defaultPersonalListId: FieldValue.delete() });
  }

  const subSnap = await userRef.collection("personalLists").get();
  if (subSnap.docs.length === 1) {
    await userRef.set({ defaultPersonalListId: subSnap.docs[0].id }, { merge: true });
    return;
  }

  const items = Array.isArray(data.items) ? data.items : [];
  const watched = Array.isArray(data.watched) ? data.watched : [];
  const maybeLater = Array.isArray(data.maybeLater) ? data.maybeLater : [];
  const archive = Array.isArray(data.archive) ? data.archive : [];
  const listName = typeof data.listName === "string" ? data.listName.trim() : "";

  const hasPayload =
    items.length > 0 ||
    watched.length > 0 ||
    maybeLater.length > 0 ||
    archive.length > 0 ||
    listName.length > 0;

  if (!hasPayload) return;

  const newId = adminRandomListId();
  const plRef = userRef.collection("personalLists").doc(newId);
  await plRef.set({
    name: listName,
    items,
    watched,
    maybeLater,
    archive,
    createdAt: new Date().toISOString(),
  });
  await userRef.update({
    defaultPersonalListId: newId,
    items: FieldValue.delete(),
    watched: FieldValue.delete(),
    maybeLater: FieldValue.delete(),
    archive: FieldValue.delete(),
    listName: FieldValue.delete(),
  });
}

/**
 * Core add-from-imdb logic (shared by HTTP handler and WhatsApp).
 * @param {string} uid
 * @param {string} imdbId
 * @param {string | null} listId
 * @param {string | null} cookiePersonalListId
 * @param {string} watchRegion
 * @returns {Promise<{ statusCode: number, body: Record<string, unknown> }>}
 */
async function performAddFromImdbByUid(uid, imdbId, listId, cookiePersonalListId, watchRegion) {
  const db = getFirestore(getApp());
  try {
    await checkFirestoreQuota(db, 10);
  } catch (e) {
    if (e instanceof QuotaExceededError) {
      logEvent({ type: "quota.exceeded", period: e.period, function: "add-from-imdb" });
      return { statusCode: 503, body: { error: "quota_exceeded", period: e.period } };
    }
    throw e;
  }

  const norm = (id) => (String(id).startsWith("tt") ? id : `tt${id}`);
  const nImdb = norm(imdbId);
  const region = String(watchRegion || "").trim().toUpperCase().slice(0, 2);

  let omdbForTmdb = null;
  try {
    const omdbStart = Date.now();
    omdbForTmdb = await fetchOMDb(nImdb);
    logEvent({
      type: "api.call",
      service: "omdb",
      imdbId: nImdb,
      durationMs: Date.now() - omdbStart,
      status: 200,
    });
  } catch (e) {
    logEvent({
      type: "api.call",
      service: "omdb",
      imdbId: nImdb,
      durationMs: 0,
      status: 500,
    });
    omdbForTmdb = null;
  }

  const tmdbKey = process.env.TMDB_API_KEY;
  let movie = null;

  // 1) TMDB from IMDb id: type, poster, genres, year, providers, trailer key
  if (tmdbKey) {
    try {
      const e = await enrichFromTmdb(nImdb, tmdbKey, region, omdbForTmdb, {
        onApiCall: ({ endpoint, imdbId, durationMs, status }) =>
          logEvent({
            type: "api.call",
            service: "tmdb",
            endpoint,
            imdbId,
            durationMs,
            status,
          }),
      });
      if (e) {
        const yt = e.youtubeId;
        movie = {
          title: e.title,
          year: e.year,
          type: e.type,
          genre: e.genre || "",
          thumb: e.thumb,
          youtubeId: normalizeStoredYoutubeTrailerId(yt),
          imdbId: nImdb,
          services: Array.isArray(e.services) ? e.services : [],
          tmdbId: e.tmdbId,
          tmdbMedia: e.type === "show" ? "tv" : "movie",
          ...(e.originalLanguage ? { originalLanguage: e.originalLanguage } : {}),
        };
      }
    } catch (err) {}
  }

  // 2) OMDb fallback when TMDB has no match
  if (!movie) {
    let omdb;
    try {
      const omdbStart = Date.now();
      omdb = omdbForTmdb || (await fetchOMDb(nImdb));
      logEvent({
        type: "api.call",
        service: "omdb",
        imdbId: nImdb,
        durationMs: Date.now() - omdbStart,
        status: 200,
      });
    } catch (e) {
      logEvent({
        type: "api.call",
        service: "omdb",
        imdbId: nImdb,
        durationMs: 0,
        status: 500,
      });
      return { statusCode: 502, body: { ok: false, error: e.message || "Title not found in TMDB or OMDb" } };
    }

    const title = omdb.Title || "Unknown";
    let year = null;
    const yearStr = String(omdb.Year || "").trim();
    if (yearStr && yearStr !== "N/A") {
      const digits = yearStr.replace(/\D/g, "").slice(0, 4);
      if (digits.length >= 4) year = parseInt(digits, 10);
    }
    if (year == null && omdb.Released && omdb.Released !== "N/A") {
      const releasedMatch = String(omdb.Released).match(/\b(19|20)\d{2}\b/);
      if (releasedMatch) year = parseInt(releasedMatch[0], 10);
    }
    const nType = (omdb.Type || "").toLowerCase() === "series" ? "show" : "movie";
    const genre = omdb.Genre || "";
    const thumb = omdb.Poster && omdb.Poster !== "N/A" ? omdb.Poster : null;

    movie = {
      title,
      year: isNaN(year) ? null : year,
      type: nType,
      genre: genre || "",
      thumb,
      youtubeId: null,
      imdbId: nImdb,
      services: [],
    };
  }

  const registryId = registryDocIdFromItem(movie);
  const regDoc = db.collection("titleRegistry").doc(registryId);

  /**
   * @param {Record<string, unknown>} mergedMovie
   * @returns {Promise<void>}
   */
  async function writeRegistryMerge(mergedMovie) {
    const payload = payloadForRegistry({ ...mergedMovie, registryId });
    const startedAt = Date.now();
    await regDoc.set(payload, { merge: true });
    logEvent({
      type: "firestore.write",
      collection: "titleRegistry",
      operation: "set",
      durationMs: Date.now() - startedAt,
    });
  }

  /**
   * @param {Record<string, unknown>} m
   * @returns {Promise<void>}
   */
  async function syncUpcomingForAddedTitle(m) {
    if (!m || m.tmdbId == null || m.tmdbId === "" || !tmdbKey) return;
    try {
      const media = m.tmdbMedia === "tv" || m.type === "show" ? "tv" : "movie";
      await runSingleTitleSync(db, tmdbKey, m.tmdbId, media, m.title);
    } catch (e) {
      console.warn("upcomingAlerts sync:", e?.message || e);
    }
  }

  /**
   * @param {unknown[]} items
   * @returns {number}
   */
  function findItemIndex(items) {
    const byRid = items.findIndex((m) => m && m.registryId === registryId);
    if (byRid >= 0) return byRid;
    const byImdb = items.findIndex((m) => m && m.imdbId && norm(m.imdbId) === nImdb);
    if (byImdb >= 0) return byImdb;
    return items.findIndex(
      (m) =>
        m &&
        !m.registryId &&
        m.title === movie.title &&
        String(m.year ?? "") === String(movie.year ?? "")
    );
  }

  /**
   * @param {unknown} arr
   * @param {string | null | undefined} fromKey
   * @param {string | null | undefined} toKey
   * @returns {unknown[]}
   */
  function remapStatusKeys(arr, fromKey, toKey) {
    if (fromKey == null || toKey == null || fromKey === toKey || !Array.isArray(arr)) return arr || [];
    const s = new Set(arr);
    if (s.has(fromKey)) {
      s.delete(fromKey);
      s.add(toKey);
    }
    return [...s];
  }

  if (listId) {
    const listRef = db.collection("sharedLists").doc(listId);
    const listSnap = await listRef.get();
    if (!listSnap.exists) {
      return { statusCode: 404, body: { ok: false, error: "Shared list not found" } };
    }
    const authAdmin = getAuth(getApp());
    /** Denormalized onto list rows + `users/{uid}` (same as client `addToSharedList`). */
    let rowAddedByDisplayName = null;
    let rowAddedByPhotoUrl = null;
    try {
      const u = await authAdmin.getUser(uid);
      rowAddedByDisplayName =
        (u.displayName && String(u.displayName).trim()) ||
        (u.email ? String(u.email).split("@")[0] : null) ||
        null;
      rowAddedByPhotoUrl = u.photoURL && String(u.photoURL).trim();
      const payload = {};
      if (rowAddedByDisplayName) payload.displayName = rowAddedByDisplayName;
      if (rowAddedByPhotoUrl) payload.photoURL = rowAddedByPhotoUrl;
      if (Object.keys(payload).length > 0) {
        await db.collection("users").doc(uid).set(payload, { merge: true });
      }
    } catch {
      /* ignore profile sync */
    }
    const listData = listSnap.data();
    const members = Array.isArray(listData.members) ? listData.members : [];
    if (!members.includes(uid)) {
      return { statusCode: 403, body: { ok: false, error: "Not a member of this shared list" } };
    }
    const items = Array.isArray(listData.items) ? [...listData.items] : [];
    let watched = Array.isArray(listData.watched) ? [...listData.watched] : [];
    let maybeLater = Array.isArray(listData.maybeLater) ? [...listData.maybeLater] : [];
    let archive = Array.isArray(listData.archive) ? [...listData.archive] : [];

    const idx = findItemIndex(items);
    const statusKey = idx >= 0 ? listKey(items[idx]) : registryId;

    if (idx >= 0) {
      if (watched.includes(statusKey) || maybeLater.includes(statusKey) || archive.includes(statusKey)) {
        return { statusCode: 200, body: { ok: true, added: false, message: `"${movie.title}" is already in the list`, title: movie.title, year: movie.year ?? null } };
      }
      const existing = items[idx];
      const merged = { ...existing, ...movie };
      await writeRegistryMerge(merged);
      const oldKey = listKey(existing);
      items[idx] = toStoredRegistryRef(registryId, existing);
      watched = remapStatusKeys(watched, oldKey, registryId);
      maybeLater = remapStatusKeys(maybeLater, oldKey, registryId);
      archive = remapStatusKeys(archive, oldKey, registryId);
    } else {
      await writeRegistryMerge(movie);
      items.push(
        toStoredRegistryRef(registryId, null, {
          addedByUid: uid,
          addedByDisplayName: rowAddedByDisplayName,
          addedByPhotoUrl: rowAddedByPhotoUrl,
        })
      );
    }

    await listRef.set({ items, watched, maybeLater, archive }, { merge: true });
    const regSnap = await regDoc.get();
    const mergedRow = { ...(regSnap.exists ? regSnap.data() : {}), ...movie, registryId };
    await syncUpcomingForAddedTitle(mergedRow);
    logEvent({
      type: "title.added",
      imdbId: nImdb,
      tmdbId: movie.tmdbId ?? null,
      title: movie.title,
      listType: "shared",
    });
    return { statusCode: 200, body: { ok: true, added: true, message: `Added "${movie.title}" to shared list`, title: movie.title, year: movie.year ?? null } };
  }

  await migrateLegacyPersonalListAdmin(db, uid);
  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();
  const uData = userSnap.exists ? userSnap.data() : {};
  const defaultPl =
    typeof uData.defaultPersonalListId === "string" ? uData.defaultPersonalListId.trim() : "";
  const targetPlId = (cookiePersonalListId && String(cookiePersonalListId).trim()) || defaultPl;
  if (!targetPlId) {
    return { statusCode: 400, body: {
        ok: false,
        error:
          "Open the watchlist app, name your main list, then try again (or pick a personal list so the site can set the bookmarklet target).",
      } };
  }
  const plRef = userRef.collection("personalLists").doc(targetPlId);
  const plSnap = await plRef.get();
  if (!plSnap.exists) {
    return { statusCode: 404, body: { ok: false, error: "Personal list not found. Switch list in the app and try again." } };
  }
  const data = plSnap.data() || {};
  const items = Array.isArray(data.items) ? [...data.items] : [];
  let watched = Array.isArray(data.watched) ? [...data.watched] : [];
  let maybeLater = Array.isArray(data.maybeLater) ? [...data.maybeLater] : [];
  let archive = Array.isArray(data.archive) ? [...data.archive] : [];

  const idx = findItemIndex(items);
  const statusKey = idx >= 0 ? listKey(items[idx]) : registryId;

  let shouldSyncUpcoming = false;

  if (idx >= 0) {
    if (watched.includes(statusKey) || maybeLater.includes(statusKey) || archive.includes(statusKey)) {
      return { statusCode: 200, body: { ok: true, added: false, message: `"${movie.title}" is already in your list`, title: movie.title, year: movie.year ?? null } };
    }
    const existing = items[idx];
    const merged = { ...existing, ...movie };
    const needMerge =
      (existing.year == null && movie.year != null) ||
      (!existing.thumb && movie.thumb) ||
      (!existing.genre && movie.genre) ||
      (!isPlayableYoutubeTrailerId(existing.youtubeId) && isPlayableYoutubeTrailerId(movie.youtubeId)) ||
      ((!existing.services || existing.services.length === 0) && movie.services && movie.services.length > 0) ||
      (movie.tmdbId != null && movie.tmdbId !== "" && (existing.tmdbId == null || existing.tmdbId === ""));

    if (needMerge) {
      if (movie.tmdbId != null && movie.tmdbId !== "" && (existing.tmdbId == null || existing.tmdbId === "")) {
        shouldSyncUpcoming = true;
      }
    } else if (movie.tmdbId != null && movie.tmdbId !== "" && (existing.tmdbId == null || existing.tmdbId === "")) {
      shouldSyncUpcoming = true;
    }

    await writeRegistryMerge(merged);
    const oldKey = listKey(existing);
    items[idx] = toStoredRegistryRef(registryId, existing);
    watched = remapStatusKeys(watched, oldKey, registryId);
    maybeLater = remapStatusKeys(maybeLater, oldKey, registryId);
    archive = remapStatusKeys(archive, oldKey, registryId);
  } else {
    await writeRegistryMerge(movie);
    items.push(toStoredRegistryRef(registryId));
    if (movie.tmdbId != null && movie.tmdbId !== "") shouldSyncUpcoming = true;
  }

  await plRef.set({ items, watched, maybeLater, archive }, { merge: true });

  if (shouldSyncUpcoming || idx < 0) {
    const regSnap = await regDoc.get();
    const mergedRow = { ...(regSnap.exists ? regSnap.data() : {}), ...movie, registryId };
    await syncUpcomingForAddedTitle(mergedRow);
  }
  logEvent({
    type: "title.added",
    imdbId: nImdb,
    tmdbId: movie.tmdbId ?? null,
    title: movie.title,
    listType: "personal",
  });

  return { statusCode: 200, body: { ok: true, added: true, message: `Added "${movie.title}" to To Watch`, title: movie.title, year: movie.year ?? null } };
}



/**
 * @param {import('@netlify/functions').HandlerEvent} event
 * @param {import('@netlify/functions').HandlerContext} context
 * @returns {Promise<import('@netlify/functions').HandlerResponse>}
 */
exports.handler = async (event, context) => {
  try {
  logEvent({ type: "function.invoked", trigger: "bookmarklet" });
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(event) };
  }

  if (event.httpMethod !== "POST") {
    return jsonRes(405, { ok: false, error: "Method not allowed" }, event);
  }

  const cookies = {};
  (event.headers?.cookie || "").split(";").forEach((c) => {
    const [k, v] = c.trim().split("=").map((s) => (s || "").trim());
    if (k && v) cookies[k] = decodeURIComponent(v);
  });
  const token = cookies.bookmarklet_token || (event.headers?.authorization || "").replace("Bearer ", "");
  if (!token) {
    return jsonRes(401, { ok: false, error: "Sign in on the watchlist site first" }, event);
  }

  let uid;
  try {
    const app = getApp();
    const auth = getAuth(app);
    const decoded = await auth.verifyIdToken(token);
    uid = decoded.uid;
  } catch (e) {
    return jsonRes(401, { ok: false, error: "Invalid or expired token. Sign in again." }, event);
  }

  let body;
  try {
    body = typeof event.body === "string" ? JSON.parse(event.body) : event.body || {};
  } catch (e) {
    return jsonRes(400, { ok: false, error: "Invalid JSON body" }, event);
  }
  const { imdbId, listId: bodyListId, personalListId: bodyPersonalListId, watch_region: bodyWatch } = body;
  const listId = bodyListId || cookies.bookmarklet_list_id || null;
  const cookiePersonalListId =
    cookies.bookmarklet_personal_list_id ||
    (typeof bodyPersonalListId === "string" ? bodyPersonalListId : null);
  if (!imdbId) {
    return jsonRes(400, { ok: false, error: "imdbId required" }, event);
  }

  const watchRegion = String(bodyWatch || body.watchRegion || "").trim().toUpperCase().slice(0, 2);
  const r = await performAddFromImdbByUid(uid, imdbId, listId, cookiePersonalListId, watchRegion);
  return jsonRes(r.statusCode, r.body, event);
  } catch (err) {
    captureException(err);
    const msg = presentableErrorMessage(err);
    console.error("add-from-imdb fatal:", err);
    logEvent({ type: "function.error", error: msg });
    return jsonRes(500, { ok: false, error: msg }, event);
  }
};

const { wrapNetlifyHandler } = require("../src/api-lib/vercel-adapter");
const vercelHandler = wrapNetlifyHandler(exports.handler);
vercelHandler.performAddFromImdbByUid = performAddFromImdbByUid;
module.exports = vercelHandler;
