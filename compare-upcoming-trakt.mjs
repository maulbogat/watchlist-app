#!/usr/bin/env node
/**
 * Compare TMDB vs Trakt for "next TV episode" using the same Firestore sources as check-upcoming.mjs.
 *
 * READ-ONLY — no writes to Firestore or Trakt.
 *
 * Trakt ID lookup (no OAuth needed):
 *   GET https://api.trakt.tv/search/tmdb/{tmdb_id}?type=show
 *   GET https://api.trakt.tv/search/imdb/{imdb_id}?type=show   (imdb_id like tt0944947)
 * Then:
 *   GET https://api.trakt.tv/shows/{slug}/next_episode?extended=full
 *
 * Requires in .env:
 *   TRAKT_CLIENT_ID  — https://trakt.tv/oauth/applications (use "Client ID")
 *   TMDB_API_KEY
 *   FIREBASE_SERVICE_ACCOUNT (base64) or serviceAccountKey.json in project root
 *
 * Output filter: only prints rows where TMDB has a dated next episode (or TMDB fetch error),
 * OR Trakt returns a next episode (not HTTP 204). Rows where both are “empty” are skipped.
 *
 * Run: node compare-upcoming-trakt.mjs
 */

import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMDB_BASE = "https://api.themoviedb.org/3";
const TRAKT_BASE = "https://api.trakt.tv";
const FETCH_TIMEOUT_MS = 15_000;
const RATE_MS = 350;
const USER_AGENT = "movie-trailer-site/compare-upcoming-trakt (local; https://github.com/trakt/trakt-api)";

let requestTurn = Promise.resolve();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Queue requests so Trakt + TMDB never overlap burst (single delay chain). */
async function throttle() {
  const next = requestTurn.then(() => sleep(RATE_MS));
  requestTurn = next.catch(() => {});
  await next;
}

function normalizeImdbId(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.startsWith("tt") ? s : `tt${s.replace(/^tt/i, "")}`;
}

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(String(iso).includes("T") ? iso : `${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function episodeLine(ep) {
  if (!ep) return "—";
  const sn = ep.season;
  const en = ep.number;
  const title = ep.title ? ` "${ep.title}"` : "";
  const air = ep.first_aired ? formatDate(ep.first_aired) : "TBA";
  if (sn != null && en != null) return `S${sn}E${en}${title} — ${air}`;
  return `${title.trim() || "episode"} — ${air}`;
}

async function tmdbGet(apiKey, path) {
  await throttle();
  const url = new URL(`${TMDB_BASE}${path.startsWith("/") ? path : `/${path}`}`);
  url.searchParams.set("api_key", apiKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timer);
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      return { ok: false, status: res.status, data, error: data?.status_message || res.statusText };
    }
    return { ok: true, data };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, status: 0, data: null, error: e?.message || String(e) };
  }
}

async function traktGet(clientId, path) {
  await throttle();
  const url = `${TRAKT_BASE}${path.startsWith("/") ? path : `/${path}`}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "trakt-api-version": "2",
        "trakt-api-key": clientId,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
    });
    clearTimeout(timer);
    if (res.status === 204) {
      return { ok: true, status: 204, data: null };
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        data,
        error: typeof data === "object" && data?.error ? data.error : res.statusText,
      };
    }
    return { ok: true, status: res.status, data };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, status: 0, data: null, error: e?.message || String(e) };
  }
}

function initFirestore() {
  let key;
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT;
  const keyPath = join(__dirname, "serviceAccountKey.json");
  try {
    if (b64) {
      key = JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
    } else if (existsSync(keyPath)) {
      key = JSON.parse(readFileSync(keyPath, "utf-8"));
    } else {
      console.error("Set FIREBASE_SERVICE_ACCOUNT (base64 JSON) or add serviceAccountKey.json in project root.");
      process.exit(1);
    }
  } catch (e) {
    console.error("Invalid Firebase credentials:", e?.message || e);
    process.exit(1);
  }
  initializeApp({ credential: cert(key) });
  return getFirestore();
}

async function collectAllItems(db) {
  const { loadAllRegistryMap, hydrateListRow } = await import("./scripts/lib/registry-query.mjs");
  const regMap = await loadAllRegistryMap(db);
  const out = [...regMap.values()];

  const usersSnap = await db.collection("users").get();
  for (const userDoc of usersSnap.docs) {
    const d = userDoc.data();
    if (Array.isArray(d.items)) {
      for (const row of d.items) {
        const h = hydrateListRow(row, regMap);
        if (h) out.push(h);
      }
    }

    const plSnap = await db.collection("users").doc(userDoc.id).collection("personalLists").get();
    for (const plDoc of plSnap.docs) {
      const p = plDoc.data();
      if (Array.isArray(p.items)) {
        for (const row of p.items) {
          const h = hydrateListRow(row, regMap);
          if (h) out.push(h);
        }
      }
    }
  }

  const sharedSnap = await db.collection("sharedLists").get();
  for (const doc of sharedSnap.docs) {
    const d = doc.data();
    if (Array.isArray(d.items)) {
      for (const row of d.items) {
        const h = hydrateListRow(row, regMap);
        if (h) out.push(h);
      }
    }
  }

  return out;
}

/**
 * Deduped TV rows for comparison: prefer TMDB id; include IMDb-only shows that lack TMDB id.
 * @returns {Array<{ title: string, tmdbId: number | null, imdbId: string | null }>}
 */
function collectTvCatalogItems(rawItems) {
  /** @type {Map<number, { title: string, tmdbId: number, imdbId: string | null }>} */
  const byTmdbTv = new Map();
  /** @type {Map<string, { title: string, tmdbId: null, imdbId: string }>} */
  const imdbOnlyTv = new Map();

  for (const m of rawItems) {
    if (!m || typeof m !== "object") continue;
    const isTv = m.tmdbMedia === "tv" || m.type === "show";
    if (!isTv) continue;

    const title = String(m.title ?? "Unknown");
    const imdb = normalizeImdbId(m.imdbId);
    const t = m.tmdbId;
    const n = t != null && t !== "" ? Number(t) : NaN;

    if (!Number.isNaN(n)) {
      const prev = byTmdbTv.get(n);
      const row = prev || { title, tmdbId: n, imdbId: imdb };
      if (imdb && !row.imdbId) row.imdbId = imdb;
      if (title && title !== "Unknown") row.title = title;
      byTmdbTv.set(n, row);
    } else if (imdb) {
      if (!imdbOnlyTv.has(imdb)) {
        imdbOnlyTv.set(imdb, { title, tmdbId: null, imdbId: imdb });
      }
    }
  }

  const imdbUsed = new Set([...byTmdbTv.values()].map((r) => r.imdbId).filter(Boolean));
  for (const imdb of imdbOnlyTv.keys()) {
    if (imdbUsed.has(imdb)) imdbOnlyTv.delete(imdb);
  }

  return [...byTmdbTv.values(), ...imdbOnlyTv.values()];
}

/** @returns {{ slug: string, traktTitle: string } | null} */
async function traktResolveShow(clientId, row) {
  if (row.tmdbId != null) {
    const r = await traktGet(clientId, `/search/tmdb/${row.tmdbId}?type=show`);
    if (r.ok && Array.isArray(r.data) && r.data.length > 0) {
      const hit = r.data.find((x) => x.type === "show" && x.show?.ids?.slug);
      const show = hit?.show;
      if (show?.ids?.slug) {
        return { slug: show.ids.slug, traktTitle: show.title || row.title };
      }
    }
  }

  if (row.imdbId) {
    const r = await traktGet(clientId, `/search/imdb/${encodeURIComponent(row.imdbId)}?type=show`);
    if (r.ok && Array.isArray(r.data) && r.data.length > 0) {
      const hit = r.data.find((x) => x.type === "show" && x.show?.ids?.slug);
      const show = hit?.show;
      if (show?.ids?.slug) {
        return { slug: show.ids.slug, traktTitle: show.title || row.title };
      }
    }
  }

  return null;
}

function tmdbNextFromDetail(data) {
  const n = data?.next_episode_to_air;
  if (!n) return null;
  if (!n.air_date || String(n.air_date).trim() === "") return null;
  return {
    season: n.season_number,
    number: n.episode_number,
    title: n.name,
    first_aired: n.air_date,
  };
}

/**
 * TMDB side is "none / TBA" only when: no tmdb id, or fetch succeeded but no dated next ep.
 * Fetch errors count as "not absent" so they still appear.
 */
function tmdbIsNoneOrTba(row, td, tmdbEp) {
  if (row.tmdbId == null) return true;
  if (!td) return true;
  if (!td.ok) return false;
  return tmdbEp == null;
}

/** Trakt has a real next episode (not HTTP 204 empty). */
function traktHasNextEpisode(traktEp) {
  return traktEp != null;
}

async function main() {
  const tmdbKey = process.env.TMDB_API_KEY;
  const traktClientId = process.env.TRAKT_CLIENT_ID;
  if (!tmdbKey || !String(tmdbKey).trim()) {
    console.error("Missing TMDB_API_KEY in .env");
    process.exit(1);
  }
  if (!traktClientId || !String(traktClientId).trim()) {
    console.error("Missing TRAKT_CLIENT_ID in .env (Trakt → OAuth apps → Client ID)");
    process.exit(1);
  }

  const db = initFirestore();
  let rawItems = [];
  try {
    rawItems = await collectAllItems(db);
  } catch (e) {
    console.error("Firestore read failed:", e?.message || e);
    process.exit(1);
  }

  const tvRows = collectTvCatalogItems(rawItems);

  console.log("");
  console.log("================================================================");
  console.log("TMDB vs Trakt — next episode (filtered)");
  console.log("================================================================");
  console.log(
    `Shows in titleRegistry / lists: ${tvRows.length} — printing only rows where TMDB ≠ none/TBA OR Trakt ≠ 204 empty`
  );
  console.log("");

  let printed = 0;
  let linked = 0;
  let tmdbHadNext = 0;
  let traktHadNext = 0;
  let bothSameAirDate = 0;

  for (const row of tvRows) {
    const via =
      row.tmdbId != null
        ? `tmdb:${row.tmdbId}${row.imdbId ? `  imdb:${row.imdbId}` : ""}`
        : `imdb:${row.imdbId}`;

    /** @type {{ ok: boolean, data?: object, error?: string, status?: number } | null} */
    let td = null;
    let tmdbEp = null;
    if (row.tmdbId != null) {
      td = await tmdbGet(tmdbKey, `/tv/${row.tmdbId}`);
      if (td.ok && td.data) {
        tmdbEp = tmdbNextFromDetail(td.data);
      }
    }

    const resolved = await traktResolveShow(traktClientId, row);

    let traktEp = null;
    if (resolved) {
      const ne = await traktGet(
        traktClientId,
        `/shows/${encodeURIComponent(resolved.slug)}/next_episode?extended=full`
      );
      if (ne.ok && ne.status !== 204 && ne.data && typeof ne.data === "object") {
        traktEp = {
          season: ne.data.season,
          number: ne.data.number,
          title: ne.data.title,
          first_aired: ne.data.first_aired,
        };
      }
    }

    const tmdbNoneOrTba = tmdbIsNoneOrTba(row, td, tmdbEp);
    const traktHasNext = traktHasNextEpisode(traktEp);
    if (tmdbNoneOrTba && !traktHasNext) {
      continue;
    }

    printed++;
    if (resolved) linked++;
    if (tmdbEp) tmdbHadNext++;
    if (traktEp) traktHadNext++;

    const tmdbAir = tmdbEp?.first_aired ? String(tmdbEp.first_aired).slice(0, 10) : "";
    const traktAir = traktEp?.first_aired ? String(traktEp.first_aired).slice(0, 10) : "";
    if (tmdbAir && traktAir && tmdbAir === traktAir) bothSameAirDate++;

    if (!resolved) {
      console.log(`— ${row.title}`);
      console.log(`    Link: ${via}`);
      console.log(`    Trakt: NO MATCH (try alternate id or spelling on trakt.tv)`);
      let tmdbLine = "    TMDB:  —";
      if (row.tmdbId != null) {
        if (td?.ok && td.data) {
          tmdbLine = `    TMDB:  ${tmdbEp ? episodeLine(tmdbEp) : "(no next_episode_to_air / TBA)"}`;
        } else if (td && !td.ok) {
          tmdbLine = `    TMDB:  error ${td.error || td.status}`;
        }
      }
      console.log(tmdbLine);
      console.log("");
      continue;
    }

    console.log(`• ${row.title}`);
    console.log(`    List:  ${via}`);
    console.log(`    Trakt: ${resolved.traktTitle}  (slug: ${resolved.slug})`);
    console.log(`    TMDB:  ${tmdbEp ? episodeLine(tmdbEp) : row.tmdbId == null ? "(no tmdb id)" : "(none / TBA)"}`);
    console.log(`    Trakt: ${traktEp ? episodeLine(traktEp) : "(204 no next episode)"}`);
    if (tmdbAir || traktAir) {
      const match =
        tmdbAir && traktAir
          ? tmdbAir === traktAir
            ? "same air date"
            : `DIFFERENT dates (${tmdbAir} vs ${traktAir})`
          : "one side missing date";
      console.log(`    Compare: ${match}`);
    }
    console.log("");
  }

  console.log("----------------------------------------------------------------");
  console.log("SUMMARY");
  console.log("----------------------------------------------------------------");
  console.log(`TV rows scanned:       ${tvRows.length}`);
  console.log(`Rows printed:          ${printed} (TMDB dated next or TMDB error, or Trakt next ep)`);
  console.log(`Matched on Trakt:      ${linked} (among printed)`);
  console.log(`TMDB had next ep:      ${tmdbHadNext} (among printed)`);
  console.log(`Trakt had next ep:     ${traktHadNext} (among printed)`);
  console.log(`Same first_aired:      ${bothSameAirDate} (among printed, both dated)`);
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
