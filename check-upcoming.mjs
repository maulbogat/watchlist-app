#!/usr/bin/env node
/**
 * Standalone diagnostic: read Firestore lists, query TMDB for upcoming/recent releases.
 * READ-ONLY — does not modify Firestore, databases, or project files.
 *
 * Requires: TMDB_API_KEY in .env
 * Firebase: FIREBASE_SERVICE_ACCOUNT (base64 JSON) or serviceAccountKey.json in project root
 *
 * Run: node check-upcoming.mjs
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
const FETCH_TIMEOUT_MS = 15_000;
const RATE_MS = 300;

function movieKey(m) {
  return `${m?.title ?? ""}|${m.year ?? ""}`;
}

function formatDate(iso) {
  if (!iso) return "TBA";
  const d = new Date(String(iso).includes("T") ? iso : `${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function parseReleaseDate(str) {
  if (!str || str === "") return null;
  const d = new Date(String(str).includes("T") ? str : `${str}T12:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isFuture(date) {
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return date > end;
}

function isInLast60Days(date) {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - 60);
  start.setHours(0, 0, 0, 0);
  return date >= start && date <= now;
}

let isFirstTmdbCall = true;

async function tmdbGet(apiKey, path) {
  if (!isFirstTmdbCall) {
    await new Promise((r) => setTimeout(r, RATE_MS));
  }
  isFirstTmdbCall = false;

  const url = new URL(`${TMDB_BASE}${path.startsWith("/") ? path : `/${path}`}`);
  url.searchParams.set("api_key", apiKey);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), { signal: controller.signal });
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
  const out = [];

  const regSnap = await db.collection("titleRegistry").get();
  for (const d of regSnap.docs) {
    out.push({ ...d.data(), registryId: d.id });
  }

  const usersSnap = await db.collection("users").get();
  for (const userDoc of usersSnap.docs) {
    const d = userDoc.data();
    if (Array.isArray(d.items)) out.push(...d.items);

    const plSnap = await db.collection("users").doc(userDoc.id).collection("personalLists").get();
    for (const plDoc of plSnap.docs) {
      const p = plDoc.data();
      if (Array.isArray(p.items)) out.push(...p.items);
    }
  }

  const sharedSnap = await db.collection("sharedLists").get();
  for (const doc of sharedSnap.docs) {
    const d = doc.data();
    if (Array.isArray(d.items)) out.push(...d.items);
  }

  return out;
}

function dedupeByTmdb(items) {
  /** @type {Map<string, { title: string, year: unknown, tmdbId: number, isTv: boolean }>} */
  const map = new Map();
  const noId = new Map();

  for (const m of items) {
    if (!m || typeof m !== "object") continue;
    const title = m.title ?? "";
    const year = m.year ?? "";
    const t = m.tmdbId;
    if (t == null || t === "") {
      const k = movieKey(m);
      if (k.replace(/\|/g, "").trim()) noId.set(k, { title, year });
      continue;
    }
    const n = Number(t);
    if (Number.isNaN(n)) {
      noId.set(movieKey(m), { title, year });
      continue;
    }
    const isTv = m.tmdbMedia === "tv" || m.type === "show";
    const key = `${n}|${isTv ? "tv" : "movie"}`;
    if (!map.has(key)) {
      map.set(key, { title: String(title), year, tmdbId: n, isTv });
    }
  }

  return { byTmdb: map, noTmdbId: noId };
}

/**
 * @param {Set<number>} catalogMovieIds — TMDB movie ids present in your watchlist data (deduped).
 * Recently released: only collection parts (same franchise/collection as a listed title), or
 * recommendations whose id is in this set (title is in your lists / registry).
 */
async function processMovie(apiKey, movieId, catalogMovieIds) {
  const sections = {
    upcoming: [],
    recent: [],
  };

  const detail = await tmdbGet(apiKey, `/movie/${movieId}`);
  if (!detail.ok || !detail.data) {
    return sections;
  }

  const movie = detail.data;
  const seenUpcoming = new Set();
  const seenRecent = new Set();

  const col = movie.belongs_to_collection;
  if (col && col.id != null) {
    const collRes = await tmdbGet(apiKey, `/collection/${col.id}`);
    if (collRes.ok && collRes.data?.parts) {
      const cname = collRes.data.name || "Collection";
      for (const part of collRes.data.parts) {
        if (!part || part.id === movieId) continue;
        const rd = parseReleaseDate(part.release_date);
        if (!rd) continue;
        const rel = formatDate(part.release_date);
        if (rel === "TBA") continue;
        const label = part.title || `Movie ${part.id}`;
        const yearStr = part.release_date ? String(part.release_date).slice(0, 4) : "";
        const lineTitle = yearStr ? `${label} (${yearStr})` : label;
        if (isFuture(rd)) {
          if (!seenUpcoming.has(part.id)) {
            seenUpcoming.add(part.id);
            sections.upcoming.push({
              id: part.id,
              lineTitle,
              release: rel,
              collection: cname,
            });
          }
        } else if (isInLast60Days(rd)) {
          if (!seenRecent.has(part.id)) {
            seenRecent.add(part.id);
            sections.recent.push({
              id: part.id,
              title: label,
              released: rel,
              via: `Same collection: ${cname}`,
            });
          }
        }
      }
    }
  }

  const recRes = await tmdbGet(apiKey, `/movie/${movieId}/recommendations`);
  if (recRes.ok && Array.isArray(recRes.data?.results)) {
    for (const r of recRes.data.results) {
      if (!r || r.id === movieId) continue;
      const rd = parseReleaseDate(r.release_date);
      if (!rd) continue;
      const rel = formatDate(r.release_date);
      if (rel === "TBA") continue;
      const label = r.title || `Movie ${r.id}`;
      const yearStr = r.release_date ? String(r.release_date).slice(0, 4) : "";
      const lineTitle = yearStr ? `${label} (${yearStr})` : label;
      if (isFuture(rd)) {
        if (!seenUpcoming.has(r.id)) {
          seenUpcoming.add(r.id);
          sections.upcoming.push({
            id: r.id,
            lineTitle,
            release: rel,
            collection: "(from recommendations)",
          });
        }
      } else if (isInLast60Days(rd) && catalogMovieIds.has(r.id)) {
        if (!seenRecent.has(r.id)) {
          seenRecent.add(r.id);
          sections.recent.push({
            id: r.id,
            title: label,
            released: rel,
            via: "On your watchlist",
          });
        }
      }
    }
  }

  return sections;
}

function processTvData(data, displayTitle) {
  const name = data.name || displayTitle;
  const status = data.status || "";

  if (data.next_episode_to_air) {
    const n = data.next_episode_to_air;
    if (!n.air_date || String(n.air_date).trim() === "") {
      return null;
    }
    const air = formatDate(n.air_date);
    if (air === "TBA") {
      return null;
    }
    let nextLine = "Next: ";
    if (n.season_number != null && n.episode_number != null) {
      nextLine += `Season ${n.season_number}, Episode ${n.episode_number} — ${air}`;
    } else if (n.season_number != null) {
      nextLine += `Season ${n.season_number} — ${air}`;
    } else {
      nextLine += air;
    }
    return { name, nextLine, status };
  }

  return null;
}

async function processTv(apiKey, displayTitle, tvId) {
  const detail = await tmdbGet(apiKey, `/tv/${tvId}`);
  if (!detail.ok || !detail.data) {
    return { seasons: null, error: detail.error || String(detail.status) || "fetch failed" };
  }
  return { seasons: processTvData(detail.data, displayTitle), error: null };
}

async function main() {
  const started = Date.now();
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey || !String(apiKey).trim()) {
    console.error("Missing TMDB_API_KEY in environment (.env).");
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

  const { byTmdb } = dedupeByTmdb(rawItems);
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const tvLines = [];
  const movieUpcoming = [];
  const movieRecent = [];

  const seenUpcomingId = new Set();
  const seenRecentId = new Set();

  const entries = [...byTmdb.values()];
  /** @type {Set<number>} */
  const catalogMovieIds = new Set();
  for (const e of entries) {
    if (!e.isTv) catalogMovieIds.add(e.tmdbId);
  }

  for (const entry of entries) {
    const displayTitle = entry.title || "Unknown";
    try {
      if (entry.isTv) {
        const r = await processTv(apiKey, displayTitle, entry.tmdbId);
        if (r.seasons) {
          tvLines.push(r.seasons);
        }
      } else {
        const m = await processMovie(apiKey, entry.tmdbId, catalogMovieIds);
        for (const u of m.upcoming) {
          if (u.id != null && seenUpcomingId.has(u.id)) continue;
          if (u.id != null) seenUpcomingId.add(u.id);
          movieUpcoming.push(u);
        }
        for (const rec of m.recent) {
          if (rec.id != null && seenRecentId.has(rec.id)) continue;
          if (rec.id != null) seenRecentId.add(rec.id);
          movieRecent.push(rec);
        }
      }
    } catch {
      /* skip — diagnostic continues */
    }
  }

  console.log("");
  console.log("==============================");
  console.log(`UPCOMING REPORT — ${today}`);
  console.log("==============================");
  console.log("");

  console.log("📺 NEW SEASONS / EPISODES");
  console.log("─────────────────────────");
  if (tvLines.length === 0) {
    console.log("(none)");
  } else {
    for (const s of tvLines) {
      console.log(s.name);
      console.log(`  ${s.nextLine}`);
      console.log(`  Status: ${s.status || "—"}`);
      console.log("");
    }
  }

  console.log("🎬 UPCOMING MOVIES / SEQUELS");
  console.log("─────────────────────────────");
  if (movieUpcoming.length === 0) {
    console.log("(none)");
  } else {
    for (const m of movieUpcoming) {
      console.log(m.lineTitle);
      console.log(`  Release: ${m.release}`);
      console.log(`  Part of collection: ${m.collection}`);
      console.log("");
    }
  }

  console.log("✅ RECENTLY RELEASED (last 60 days)");
  console.log("────────────────────────────────────");
  console.log("Only titles in your lists, or same TMDB collection as a title you have.");
  if (movieRecent.length === 0) {
    console.log("(none)");
  } else {
    for (const m of movieRecent) {
      console.log(m.title);
      console.log(`  Released: ${m.released}`);
      console.log(`  ${m.via}`);
      console.log("");
    }
  }

  const totalChecked = entries.length;
  const upcomingFound = tvLines.length + movieUpcoming.length;
  const recentlyReleased = movieRecent.length;
  const runtimeSec = ((Date.now() - started) / 1000).toFixed(2);

  console.log("");
  console.log("==============================");
  console.log("SUMMARY");
  console.log("==============================");
  console.log(`Total titles checked: ${totalChecked}`);
  console.log(`Upcoming found: ${upcomingFound}`);
  console.log(`Recently released (filtered): ${recentlyReleased}`);
  console.log("==============================");
  console.log(`Total runtime: ${runtimeSec}s`);
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
