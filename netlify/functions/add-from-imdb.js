/**
 * Netlify Function: Add movie from IMDb to catalog and optionally to user's watchlist.
 * POST body: { imdbId, title, year?, type? }
 * Cookie: bookmarklet_token (Firebase ID token) for adding to watchlist.
 * Set FIREBASE_SERVICE_ACCOUNT in Netlify env (base64 of serviceAccountKey.json).
 */
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

let app;
function getApp() {
  if (app) return app;
  const encoded = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!encoded) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT env var not set");
  }
  const key = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"));
  app = initializeApp({ credential: cert(key) });
  return app;
}

const norm = (id) => (String(id || "").startsWith("tt") ? id : `tt${id}`);
const movieKey = (m) => `${m.title}|${m.year ?? ""}`;

function parseCookie(cookieHeader) {
  if (!cookieHeader) return {};
  return Object.fromEntries(
    cookieHeader.split(";").map((s) => {
      const [k, ...v] = s.trim().split("=");
      return [k, v.join("=").trim()];
    })
  );
}

function corsHeaders(event) {
  const origin = event.headers?.origin || event.headers?.Origin || "*";
  const allowed = ["https://www.imdb.com", "https://imdb.com", "https://watchlist-trailers.netlify.app", "http://localhost:5173"];
  const allow = allowed.includes(origin) ? origin : allowed[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
}

exports.handler = async (event) => {
  const headers = corsHeaders(event);
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) };
  }
  const { imdbId, title, year, type } = body;
  if (!imdbId || !title) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "imdbId and title required" }),
    };
  }
  let uid = null;
  const cookies = parseCookie(event.headers?.cookie || event.headers?.Cookie);
  const token = cookies.bookmarklet_token;
  if (token) {
    try {
      getApp();
      const decoded = await getAuth(app).verifyIdToken(token);
      uid = decoded.uid;
    } catch (e) {
      // Token invalid or expired, continue without uid
    }
  }
  try {
    getApp();
    const db = getFirestore(app);
    const ref = db.collection("catalog").doc("movies");
    const snap = await ref.get();
    if (!snap.exists || !Array.isArray(snap.data().items)) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: "Catalog not found" }),
      };
    }
    const items = snap.data().items;
    const nImdb = norm(imdbId);
    let movie = items.find(
      (m) =>
        (m.imdbId && norm(m.imdbId) === nImdb) ||
        (m.title === title && String(m.year ?? "") === String(year ?? ""))
    );
    if (!movie) {
      movie = {
        title: String(title).trim(),
        year: year ? Number(year) : null,
        type: type === "show" ? "show" : "movie",
        genre: "Comedy / Drama",
        youtubeId: "SEARCH",
        services: [],
        imdbId: nImdb,
      };
      items.push(movie);
      await ref.set({
        items,
        updatedAt: new Date().toISOString(),
      });
    }
    const displayTitle = movie.title || title;
    let message;
    if (uid) {
      const userRef = db.collection("users").doc(uid);
      const key = movieKey(movie);
      await userRef.set(
        {
          watched: FieldValue.arrayRemove(key),
          maybeLater: FieldValue.arrayRemove(key),
          archive: FieldValue.arrayRemove(key),
        },
        { merge: true }
      );
      message = `Added "${displayTitle}" to To Watch`;
    } else {
      message = `Added "${displayTitle}" to catalog. Visit the watchlist site and sign in to add to your list.`;
    }
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        added: true,
        message,
      }),
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: "Failed to add",
        message: err.message || "Unknown error",
      }),
    };
  }
};
