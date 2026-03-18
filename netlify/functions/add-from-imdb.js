const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const https = require("https");

function getApp() {
  if (global.__fbAdmin) return global.__fbAdmin;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT not set");
  const key = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
  const app = initializeApp({ credential: cert(key) });
  global.__fbAdmin = app;
  return app;
}

function movieKey(m) {
  return `${m.title}|${m.year ?? ""}`;
}

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

function jsonRes(status, body, event) {
  return {
    statusCode: status,
    headers: corsHeaders(event),
    body: JSON.stringify(body),
  };
}

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

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

async function fetchTrailerFromTmdb(imdbId, apiKey) {
  const findUrl = `https://api.themoviedb.org/3/find/${imdbId}?external_source=imdb_id&api_key=${apiKey}`;
  const find = await fetchJson(findUrl);
  const movie = find.movie_results?.[0];
  const tv = find.tv_results?.[0];
  const id = movie?.id ?? tv?.id;
  const type = movie ? "movie" : "tv";
  if (!id) return null;
  const videosUrl = `https://api.themoviedb.org/3/${type}/${id}/videos?api_key=${apiKey}`;
  const videos = await fetchJson(videosUrl);
  const trailer = (videos.results || []).find((v) => v.site === "YouTube" && (v.type === "Trailer" || v.type === "Teaser"));
  return trailer?.key || null;
}

exports.handler = async (event, context) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(event) };
  }

  // GET: fetch trailer (TMDB first, then IMDb scrape)
  if (event.httpMethod === "GET") {
    const imdbId = event.queryStringParameters?.imdbId || "";
    const norm = (id) => (String(id).startsWith("tt") ? id : `tt${id}`);
    const nImdb = norm(imdbId).trim();
    if (!nImdb || !/^tt\d+$/.test(nImdb)) {
      return jsonRes(400, { ok: false, error: "imdbId required (e.g. tt7235466)" }, event);
    }

    // 1. Try TMDB API (reliable, returns YouTube keys)
    const tmdbKey = process.env.TMDB_API_KEY;
    if (tmdbKey) {
      try {
        const youtubeId = await fetchTrailerFromTmdb(nImdb, tmdbKey);
        if (youtubeId) {
          return jsonRes(200, { ok: true, youtubeId }, event);
        }
      } catch (e) {
        // fall through to IMDb
      }
    }

    // 2. Fallback: scrape IMDb videogallery (may fail from server IPs)
    try {
      const html = await fetchHtml(`https://www.imdb.com/title/${nImdb}/videogallery`);
      const match = html.match(/\/video\/(vi\d+)/);
      if (match) {
        const videoId = match[1];
        const embedUrl = `https://www.imdb.com/video/imdb/${videoId}/imdb/embed?autoplay=true`;
        return jsonRes(200, { ok: true, embedUrl }, event);
      }
    } catch (e) {
      // ignore
    }

    return jsonRes(404, { ok: false, error: "No trailer found for this title" }, event);
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
  const { imdbId } = body;
  if (!imdbId) {
    return jsonRes(400, { ok: false, error: "imdbId required" }, event);
  }

  const norm = (id) => (String(id).startsWith("tt") ? id : `tt${id}`);
  const nImdb = norm(imdbId);

  let omdb;
  try {
    omdb = await fetchOMDb(nImdb);
  } catch (e) {
    return jsonRes(502, { ok: false, error: e.message || "Failed to fetch title from OMDb" }, event);
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

  const movie = {
    title,
    year: isNaN(year) ? null : year,
    type: nType,
    genre: genre || "",
    youtubeId: "SEARCH",
    imdbId: nImdb,
    thumb,
    services: [],
  };
  const key = movieKey(movie);

  const db = getFirestore(getApp());
  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();
  const data = userSnap.exists ? userSnap.data() : {};
  const items = Array.isArray(data.items) ? [...data.items] : [];
  const watched = Array.isArray(data.watched) ? data.watched : [];
  const maybeLater = Array.isArray(data.maybeLater) ? data.maybeLater : [];
  const archive = Array.isArray(data.archive) ? data.archive : [];
  const removed = Array.isArray(data.removed) ? data.removed : [];

  let existing = items.find((m) => m.imdbId && norm(m.imdbId) === nImdb);
  if (!existing) {
    existing = items.find((m) => m.title === title && String(m.year ?? "") === String(year ?? ""));
  }

  if (existing) {
    if (watched.includes(key) || maybeLater.includes(key) || archive.includes(key)) {
      return jsonRes(200, { ok: true, added: false, message: `"${movie.title}" is already in your list` }, event);
    }
    const idx = items.findIndex((m) => m === existing);
    if (idx >= 0 && (existing.year == null && year != null || !existing.thumb && thumb || !existing.genre && genre)) {
      if (existing.year == null && year != null) existing.year = year;
      if (!existing.thumb && thumb) existing.thumb = thumb;
      if (!existing.genre && genre) existing.genre = genre;
    }
  } else {
    items.push(movie);
  }

  await userRef.set(
    {
      items,
      watched: watched.filter((k) => k !== key),
      maybeLater: maybeLater.filter((k) => k !== key),
      archive: archive.filter((k) => k !== key),
      removed: removed.filter((k) => k !== key),
    },
    { merge: true }
  );

  return jsonRes(200, { ok: true, added: true, message: `Added "${movie.title}" to To Watch` }, event);
};
