const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
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

exports.handler = async (event, context) => {
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
  const year = omdb.Year ? parseInt(String(omdb.Year).replace(/\D/g, "").slice(0, 4), 10) : null;
  const nType = (omdb.Type || "").toLowerCase() === "series" ? "show" : "movie";
  const genre = omdb.Genre || "";
  const thumb = omdb.Poster && omdb.Poster !== "N/A" ? omdb.Poster : null;

  const db = getFirestore(getApp());
  const catalogRef = db.collection("catalog").doc("movies");
  const catalogSnap = await catalogRef.get();
  if (!catalogSnap.exists || !Array.isArray(catalogSnap.data().items)) {
    return jsonRes(500, { ok: false, error: "Catalog not found" }, event);
  }

  const items = catalogSnap.data().items;
  let movie = items.find((m) => m.imdbId && norm(m.imdbId) === nImdb);
  if (!movie) {
    movie = items.find((m) => m.title === title && (m.year ?? "") === String(year ?? ""));
  }
  if (!movie) {
    const newMovie = {
      title,
      year: isNaN(year) ? null : year,
      type: nType,
      genre: genre || "",
      youtubeId: "SEARCH",
      imdbId: nImdb,
      thumb,
      services: [],
    };
    items.push(newMovie);
    await catalogRef.set({
      items,
      updatedAt: new Date().toISOString(),
    });
    movie = newMovie;
  }

  const key = movieKey(movie);
  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();
  const data = userSnap.exists ? userSnap.data() : {};
  const watched = Array.isArray(data.watched) ? data.watched : [];
  const maybeLater = Array.isArray(data.maybeLater) ? data.maybeLater : [];
  const archive = Array.isArray(data.archive) ? data.archive : [];

  if (watched.includes(key) || maybeLater.includes(key) || archive.includes(key)) {
    return jsonRes(200, { ok: true, added: false, message: `"${movie.title}" is already in your list` }, event);
  }

  await userRef.set(
    {
      watched: watched.filter((k) => k !== key),
      maybeLater: maybeLater.filter((k) => k !== key),
      archive: archive.filter((k) => k !== key),
      removed: FieldValue.arrayRemove(key),
    },
    { merge: true }
  );

  return jsonRes(200, { ok: true, added: true, message: `Added "${movie.title}" to To Watch` }, event);
};
