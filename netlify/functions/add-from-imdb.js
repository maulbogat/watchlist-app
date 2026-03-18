/**
 * Netlify Function: Add movie from IMDb to catalog.
 * POST body: { imdbId, title, year?, type? }
 * Deduplicates by imdbId or title+year.
 * Set FIREBASE_SERVICE_ACCOUNT in Netlify env (base64 of serviceAccountKey.json).
 */
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

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

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
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
    const existing = items.find(
      (m) =>
        (m.imdbId && norm(m.imdbId) === nImdb) ||
        (m.title === title && String(m.year ?? "") === String(year ?? ""))
    );
    if (existing) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          added: false,
          message: `"${existing.title}" already in catalog`,
        }),
      };
    }
    const movie = {
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
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        added: true,
        message: `Added "${movie.title}" to catalog`,
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
