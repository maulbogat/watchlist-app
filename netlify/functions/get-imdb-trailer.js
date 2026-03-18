const https = require("https");

function corsHeaders(event) {
  const origin = event.headers?.origin || event.headers?.Origin || "*";
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };
}

function jsonRes(status, body, event) {
  return {
    statusCode: status,
    headers: corsHeaders(event),
    body: JSON.stringify(body),
  };
}

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" } }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

exports.handler = async (event, context) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(event) };
  }
  if (event.httpMethod !== "GET") {
    return jsonRes(405, { ok: false, error: "Method not allowed" }, event);
  }

  const imdbId = event.queryStringParameters?.imdbId || "";
  const norm = (id) => (String(id).startsWith("tt") ? id : `tt${id}`);
  const nImdb = norm(imdbId).trim();
  if (!nImdb || !/^tt\d+$/.test(nImdb)) {
    return jsonRes(400, { ok: false, error: "imdbId required (e.g. tt0206467)" }, event);
  }

  const url = `https://www.imdb.com/title/${nImdb}/videogallery`;
  let html;
  try {
    html = await fetchHtml(url);
  } catch (e) {
    return jsonRes(502, { ok: false, error: "Failed to fetch IMDb page" }, event);
  }

  const match = html.match(/\/video\/(vi\d+)/);
  if (!match) {
    return jsonRes(404, { ok: false, error: "No trailer found for this title" }, event);
  }

  const videoId = match[1];
  const embedUrl = `https://www.imdb.com/video/imdb/${videoId}/imdb/embed?autoplay=true`;

  return jsonRes(200, { ok: true, videoId, embedUrl }, event);
};
