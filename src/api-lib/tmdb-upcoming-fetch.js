/**
 * TMDB HTTPS helpers for **upcoming alert** generation (Netlify functions).
 * Serializes requests (~250ms apart); on HTTP 429 waits 10s and retries once.
 *
 * **Outputs:** Plain objects merged into **`upcomingAlerts`** docs (see `UpcomingAlertFirestoreDoc` in `sync-upcoming-alerts.js`).
 *
 * @module netlify/functions/lib/tmdb-upcoming-fetch
 */

/**
 * @typedef {import('../types/index.js').UpcomingAlert} UpcomingAlert
 */

const https = require("https");

const TMDB_BASE = "https://api.themoviedb.org/3";
const RATE_MS = 250;

let chain = Promise.resolve();

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function enqueue(fn) {
  chain = chain.then(fn, fn);
  return chain;
}

/**
 * @param {string} url
 * @returns {Promise<{ status: number, data: unknown }>}
 */
function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (c) => {
          data += c;
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, data: data ? JSON.parse(data) : null });
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

/**
 * @param {string} path - e.g. `/tv/136311`
 * @param {string} apiKey
 * @returns {Promise<{ ok: boolean, status: number, error?: string, data?: unknown }>}
 */
async function tmdbGet(path, apiKey) {
  const run = async () => {
    await sleep(RATE_MS);
    const url = `${TMDB_BASE}${path.startsWith("/") ? path : `/${path}`}?api_key=${encodeURIComponent(apiKey)}`;
    let { status, data } = await httpsGetJson(url);
    if (status === 429) {
      await sleep(10_000);
      const retry = await httpsGetJson(url);
      status = retry.status;
      data = retry.data;
    }
    if (status < 200 || status >= 300) {
      const msg = data?.status_message || `HTTP ${status}`;
      return { ok: false, status, error: msg, data };
    }
    return { ok: true, status, data };
  };
  return enqueue(run);
}

/**
 * @param {string | null | undefined} str
 * @returns {Date | null}
 */
function parseIsoDate(str) {
  if (!str || String(str).trim() === "") return null;
  const d = new Date(String(str).includes("T") ? str : `${str}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * @param {Date} date
 * @param {number} days
 * @returns {string} `YYYY-MM-DD`
 */
function addDaysIso(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * @returns {string}
 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * Metadata persisted in `upcomingChecks/{tmdbId_media}` for movie-only skip decisions.
 * @typedef {{
 *   releaseDate: string | null,
 *   hasCollection: boolean,
 *   collectionId: number | null
 * }} MovieCheckMeta
 */

/**
 * Build alert payloads for one catalog row (TMDB only).
 * @param {string} apiKey
 * @param {{ tmdbId: number, isTv: boolean, title?: string }} row
 * @param {{ onApiCall?: (event: { endpoint: string, tmdbId: number, status: number, durationMs: number }) => void }} [options]
 * @returns {Promise<{ alerts: object[], movieCheckMeta?: MovieCheckMeta }>} `alerts` items include `docId` plus fields aligned with {@link UpcomingAlert} / `UpcomingAlertFirestoreDoc` in `sync-upcoming-alerts.js`. Caller strips `docId` before `set`; `detectedAt` is added in `upsertAlerts`.
 */
async function buildAlertsForCatalogRow(apiKey, row, options = {}) {
  const { tmdbId, isTv, title: hintTitle } = row;
  const alerts = [];
  const onApiCall = typeof options.onApiCall === "function" ? options.onApiCall : null;

  async function tmdbGetWithLog(endpoint) {
    const t0 = Date.now();
    const response = await tmdbGet(endpoint, apiKey);
    if (onApiCall) {
      try {
        onApiCall({
          endpoint,
          tmdbId,
          status: Number(response?.status || 0),
          durationMs: Date.now() - t0,
        });
      } catch {
        // observability must never break sync
      }
    }
    return response;
  }

  if (isTv) {
    const tv = await tmdbGetWithLog(`/tv/${tmdbId}`);
    if (!tv.ok || !tv.data) return { alerts };

    const data = tv.data;
    const name = data.name || hintTitle || "TV show";
    const next = data.next_episode_to_air;

    if (next && next.air_date && String(next.air_date).trim()) {
      const air = parseIsoDate(next.air_date);
      const sn = next.season_number;
      const en = next.episode_number;
      const epName = next.name ? ` — ${next.name}` : "";
      const detail =
        sn != null && en != null
          ? `Season ${sn}, Episode ${en}${epName}`
          : next.name || "Next episode";
      const fingerprint = `${tmdbId}_${sn ?? 0}_${en ?? 0}`;
      const expiresAt = air ? addDaysIso(air, 30) : addDaysIso(new Date(), 90);
      alerts.push({
        docId: `tv_${fingerprint}`,
        fingerprint,
        catalogTmdbId: tmdbId,
        media: "tv",
        tmdbId,
        type: "tv",
        alertType: "new_episode",
        title: name,
        detail,
        airDate: String(next.air_date).slice(0, 10),
        confirmed: true,
        expiresAt,
        sequelTmdbId: null,
      });
      return { alerts };
    }

    // No dated next episode: skip "Returning / TBA" placeholders — only surface alerts with a real air date.
    return { alerts };
  }

  const mv = await tmdbGetWithLog(`/movie/${tmdbId}`);
  if (!mv.ok || !mv.data) return { alerts };
  const data = mv.data;
  const name = data.title || hintTitle || "Movie";
  const releaseDate =
    typeof data.release_date === "string" && String(data.release_date).trim()
      ? String(data.release_date).slice(0, 10)
      : null;
  const collectionRaw = data.belongs_to_collection;
  const hasCollection = Boolean(collectionRaw && collectionRaw.id != null);
  const collectionId = hasCollection ? Number(collectionRaw.id) : null;
  /** @type {MovieCheckMeta} */
  const movieCheckMeta = {
    releaseDate,
    hasCollection,
    collectionId: collectionId != null && !Number.isNaN(collectionId) ? collectionId : null,
  };

  const rd = data.release_date ? parseIsoDate(data.release_date) : null;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  if (rd && rd > today) {
    const fingerprint = `${tmdbId}_upcoming`;
    const expiresAt = addDaysIso(rd, 30);
    alerts.push({
      docId: `mv_${fingerprint}`,
      fingerprint,
      catalogTmdbId: tmdbId,
      media: "movie",
      tmdbId,
      type: "movie",
      alertType: "upcoming_movie",
      title: name,
      detail: `Theatrical release`,
      airDate: String(data.release_date).slice(0, 10),
      confirmed: true,
      expiresAt,
      sequelTmdbId: null,
    });
  }

  const col = data.belongs_to_collection;
  if (col && col.id != null) {
    const coll = await tmdbGetWithLog(`/collection/${col.id}`);
    if (!coll.ok || !coll.data?.parts) return { alerts, movieCheckMeta };
    for (const part of coll.data.parts) {
      if (!part || part.id === tmdbId) continue;
      const prd = part.release_date ? parseIsoDate(part.release_date) : null;
      if (!prd || prd <= today) continue;
      const sid = part.id;
      const stitle = part.title || `Movie ${sid}`;
      const fingerprint = `${tmdbId}_sequel_${sid}`;
      const expiresAt = addDaysIso(prd, 30);
      alerts.push({
        docId: `mv_${fingerprint}`,
        fingerprint,
        catalogTmdbId: tmdbId,
        media: "movie",
        tmdbId,
        type: "movie",
        alertType: "sequel",
        title: stitle,
        detail: `Sequel to “${name}”`,
        airDate: String(part.release_date).slice(0, 10),
        confirmed: true,
        expiresAt,
        sequelTmdbId: sid,
      });
    }
  }

  return { alerts, movieCheckMeta };
}

/**
 * Deduplicate catalog items by TMDB id + tv/movie (same as `check-upcoming.mjs`).
 * @param {object[]} items
 * @returns {{ tmdbId: number, isTv: boolean, title: string }[]}
 */
function dedupeCatalogByTmdb(items) {
  const map = new Map();
  for (const m of items) {
    if (!m || typeof m !== "object") continue;
    const t = m.tmdbId;
    if (t == null || t === "") continue;
    const n = Number(t);
    if (Number.isNaN(n)) continue;
    const isTv = m.tmdbMedia === "tv" || m.type === "show";
    const key = `${n}|${isTv ? "tv" : "movie"}`;
    if (map.has(key)) continue;
    map.set(key, {
      tmdbId: n,
      isTv,
      title: m.title || "",
    });
  }
  return [...map.values()];
}

module.exports = {
  tmdbGet,
  buildAlertsForCatalogRow,
  dedupeCatalogByTmdb,
  parseIsoDate,
  nowIso,
  sleep,
};
