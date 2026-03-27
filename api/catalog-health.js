/**
 * Admin-only catalog maintenance (POST body: `{ "imdbId": "tt…" }` — backfill `thumb` from TMDB).
 * Requires `Authorization: Bearer <Firebase ID token>` and an admin UID.
 *
 * Env: `FIREBASE_SERVICE_ACCOUNT`, `TMDB_API_KEY`
 */

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { ADMIN_UIDS } = require("../src/api-lib/admin-uids");

const APP_NAME = "watchlist-admin";
const TMDB_IMG_BASE = "https://image.tmdb.org/t/p/w500";

function getAdminApp() {
  if (global.__watchlistAdminApp) return global.__watchlistAdminApp;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT not set");
  const key = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
  const app = initializeApp({ credential: cert(key), projectId: key.project_id }, APP_NAME);
  global.__watchlistAdminApp = app;
  return app;
}

function corsHeaders() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: corsHeaders(),
    body: JSON.stringify(body),
  };
}

function resolveTmdbMedia(data) {
  const m = data && data.tmdbMedia;
  if (m === "movie" || m === "tv") return m;
  const t = data && data.type;
  if (t === "movie") return "movie";
  if (t === "show") return "tv";
  return null;
}

function normalizeImdbId(raw) {
  if (raw == null) return "";
  const s = String(raw).trim();
  if (!s) return "";
  return s.startsWith("tt") ? s : `tt${s.replace(/^tt/i, "")}`;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders() };
  }
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" });
  }

  const authHeader = (event.headers && (event.headers.authorization || event.headers.Authorization)) || "";
  const idToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!idToken) {
    return json(401, { ok: false, error: "Authorization required" });
  }

  let uid;
  try {
    const decoded = await getAuth(getAdminApp()).verifyIdToken(idToken);
    uid = decoded.uid;
  } catch {
    return json(401, { ok: false, error: "Invalid or expired token" });
  }
  if (!ADMIN_UIDS.has(uid)) {
    return json(403, { ok: false, error: "Forbidden" });
  }

  let body;
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { ok: false, error: "Invalid JSON body" });
  }

  const imdbId = normalizeImdbId(body.imdbId);
  if (!imdbId || !/^tt\d+$/i.test(imdbId)) {
    return json(400, { ok: false, error: "Missing or invalid imdbId" });
  }

  const apiKey = (process.env.TMDB_API_KEY || "").trim();
  if (!apiKey) {
    return json(503, { ok: false, error: "TMDB_API_KEY not configured" });
  }

  const db = getFirestore(getAdminApp());
  const ref = db.collection("titleRegistry").doc(imdbId);
  const snap = await ref.get();
  if (!snap.exists) {
    return json(404, { ok: false, error: "titleRegistry document not found" });
  }

  const data = snap.data() || {};
  const thumb = data.thumb;
  if (thumb != null && String(thumb).trim() !== "") {
    return json(200, { ok: true, thumb: String(thumb).trim(), alreadySet: true });
  }

  const tmdbId = data.tmdbId;
  if (tmdbId == null) {
    return json(400, { ok: false, error: "Document has no tmdbId" });
  }

  const media = resolveTmdbMedia(data);
  if (media == null) {
    return json(400, { ok: false, error: "Cannot derive TMDB media type from document" });
  }

  const url = `https://api.themoviedb.org/3/${media}/${encodeURIComponent(String(tmdbId))}?api_key=${encodeURIComponent(apiKey)}`;
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    return json(502, { ok: false, error: e instanceof Error ? e.message : "TMDB request failed" });
  }

  let details;
  try {
    details = await res.json();
  } catch {
    return json(502, { ok: false, error: "Invalid JSON from TMDB" });
  }

  if (!res.ok) {
    const msg = details?.status_message || `TMDB HTTP ${res.status}`;
    return json(502, { ok: false, error: msg });
  }

  const posterPath = details?.poster_path;
  if (!posterPath || typeof posterPath !== "string") {
    return json(404, { ok: false, error: "No poster_path from TMDB" });
  }

  const thumbUrl = `${TMDB_IMG_BASE}${posterPath}`;
  await ref.set({ thumb: thumbUrl }, { merge: true });

  return json(200, { ok: true, thumb: thumbUrl });
};

const { wrapNetlifyHandler } = require("../src/api-lib/vercel-adapter");
module.exports = wrapNetlifyHandler(exports.handler);
