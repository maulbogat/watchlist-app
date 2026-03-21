/**
 * TMDB fetch helpers for upcoming alerts (Netlify functions).
 * 250ms between calls; on 429 wait 10s and retry once.
 */

const https = require("https");

const TMDB_BASE = "https://api.themoviedb.org/3";
const RATE_MS = 250;

let chain = Promise.resolve();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function enqueue(fn) {
  chain = chain.then(fn, fn);
  return chain;
}

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
 * @param {string} path - e.g. /tv/136311
 * @param {string} apiKey
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

function parseIsoDate(str) {
  if (!str || String(str).trim() === "") return null;
  const d = new Date(String(str).includes("T") ? str : `${str}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function addDaysIso(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function nowIso() {
  return new Date().toISOString();
}

const RETURNING_LIKE = new Set(["Returning Series", "In Production", "Planned"]);

/**
 * Build alert payloads for one catalog row (TMDB only).
 * @param {string} apiKey
 * @param {{ tmdbId: number, isTv: boolean, title?: string }} row
 * @returns {Promise<object[]>} alert objects (not yet with detectedAt)
 */
async function buildAlertsForCatalogRow(apiKey, row) {
  const { tmdbId, isTv, title: hintTitle } = row;
  const alerts = [];

  if (isTv) {
    const tv = await tmdbGet(`/tv/${tmdbId}`, apiKey);
    if (!tv.ok || !tv.data) return alerts;

    const data = tv.data;
    const name = data.name || hintTitle || "TV show";
    const status = data.status || "";
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
      return alerts;
    }

    if (RETURNING_LIKE.has(status)) {
      const seasons = Number(data.number_of_seasons) || 0;
      const nextSeason = Math.max(1, seasons + 1);
      const fingerprint = `${tmdbId}_${nextSeason}_0`;
      const expiresAt = addDaysIso(new Date(), 60);
      alerts.push({
        docId: `tv_${fingerprint}`,
        fingerprint,
        catalogTmdbId: tmdbId,
        media: "tv",
        tmdbId,
        type: "tv",
        alertType: "new_season",
        title: name,
        detail: "Returning — next episode date TBA",
        airDate: null,
        confirmed: false,
        expiresAt,
        sequelTmdbId: null,
      });
    }
    return alerts;
  }

  const mv = await tmdbGet(`/movie/${tmdbId}`, apiKey);
  if (!mv.ok || !mv.data) return alerts;
  const data = mv.data;
  const name = data.title || hintTitle || "Movie";

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
    const coll = await tmdbGet(`/collection/${col.id}`, apiKey);
    if (!coll.ok || !coll.data?.parts) return alerts;
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

  return alerts;
}

/**
 * Deduplicate catalog items by TMDB id + tv/movie (same as check-upcoming.mjs).
 * @param {object[]} items
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
