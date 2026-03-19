const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const https = require("https");

/** Same rule as lib/youtube-trailer-id.js (YouTube video id from TMDB). */
const YOUTUBE_VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

function normalizeStoredYoutubeTrailerId(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  if (!YOUTUBE_VIDEO_ID_RE.test(s)) return null;
  return s;
}

function isPlayableYoutubeTrailerId(v) {
  if (v == null || typeof v !== "string") return false;
  return YOUTUBE_VIDEO_ID_RE.test(v.trim());
}

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

const TMDB_IMG = "https://image.tmdb.org/t/p/w500";

function pickYoutubeTrailerKey(results) {
  const r = results || [];
  const preferred = (t) =>
    r.find((v) => v.site === "YouTube" && v.key && v.type === t);
  const key =
    preferred("Trailer") ||
    preferred("Teaser") ||
    r.find((v) => v.site === "YouTube" && v.key && (v.type === "Clip" || v.type === "Featurette")) ||
    r.find((v) => v.site === "YouTube" && v.key);
  return key?.key || null;
}

/**
 * When TMDB returns both a movie and TV hit for one IMDb id, we must pick one.
 * Bugfix: `movie?.id ?? tv?.id` always preferred movie — wrong for TV miniseries (e.g. Cecil Hotel
 * could get another title's trailer/thumb/genres). Use OMDb Type when available; else prefer TV
 * when both exist (miniseries/docuseries are usually TV on TMDB).
 * @param {object|null} omdbHint - OMDb row { Type, Title } if already fetched
 */
function pickTmdbFindEntry(find, omdbHint) {
  const movie = find.movie_results?.[0];
  const tv = find.tv_results?.[0];
  if (!movie && !tv) return { mediaType: null, id: null };
  if (!movie) return { mediaType: "tv", id: tv.id };
  if (!tv) return { mediaType: "movie", id: movie.id };

  const t = omdbHint && String(omdbHint.Type || "").toLowerCase();
  if (t === "movie") return { mediaType: "movie", id: movie.id };
  if (t === "series" || t === "episode") return { mediaType: "tv", id: tv.id };
  // No OMDb or ambiguous: prefer TV so we don't attach a random film's trailer to a series id
  return { mediaType: "tv", id: tv.id };
}

/**
 * Full TMDB enrichment from IMDb id: type, title, year, poster, genres, trailer key, watch providers.
 * Returns null if TMDB has no match for this IMDb id.
 */
async function enrichFromTmdb(imdbId, apiKey, watchRegion, omdbHint) {
  const findUrl = `https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}?external_source=imdb_id&api_key=${apiKey}`;
  const find = await fetchJson(findUrl);
  const { mediaType, id } = pickTmdbFindEntry(find, omdbHint);
  if (id == null || !mediaType) return null;

  const detailUrl = `https://api.themoviedb.org/3/${mediaType}/${id}?append_to_response=videos&api_key=${apiKey}`;
  const detail = await fetchJson(detailUrl);

  const posterPath = detail.poster_path;
  const thumb = posterPath ? `${TMDB_IMG}${posterPath}` : null;

  const title =
    mediaType === "movie"
      ? detail.title || detail.original_title || ""
      : detail.name || detail.original_name || "";

  let year = null;
  if (mediaType === "movie") {
    const d = detail.release_date;
    if (d && String(d).length >= 4) year = parseInt(String(d).slice(0, 4), 10);
  } else {
    const d = detail.first_air_date;
    if (d && String(d).length >= 4) year = parseInt(String(d).slice(0, 4), 10);
  }
  if (Number.isNaN(year)) year = null;

  const genres = (detail.genres || []).map((g) => g.name).filter(Boolean);
  const genre = genres.join(" / ");

  const youtubeId = pickYoutubeTrailerKey(detail.videos?.results);

  let services = [];
  if (watchRegion && String(watchRegion).length >= 2) {
    const providersUrl = `https://api.themoviedb.org/3/${mediaType}/${id}/watch/providers?api_key=${apiKey}`;
    const pdata = await fetchJson(providersUrl);
    const region = pdata.results?.[String(watchRegion).toUpperCase().slice(0, 2)];
    if (region) {
      const names = new Set();
      for (const arr of [region.flatrate, region.rent, region.buy].filter(Boolean)) {
        for (const p of arr) {
          if (p.provider_name) names.add(p.provider_name);
        }
      }
      services = [...names];
    }
  }

  return {
    tmdbId: id,
    type: mediaType === "movie" ? "movie" : "show",
    title: title || "Unknown",
    year,
    thumb,
    genre,
    youtubeId,
    services,
  };
}

async function fetchTrailerFromYouTubeSearch(title, year) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return null;
  const query = [title, year ? String(year) : ""].filter(Boolean).join(" ") + " official trailer";
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=5&q=${encodeURIComponent(query)}&key=${apiKey}`;
  try {
    const data = await fetchJson(url);
    const item = (data.items || []).find((i) => i.id?.videoId);
    return item?.id?.videoId || null;
  } catch (e) {
    return null;
  }
}

exports.handler = async (event, context) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(event) };
  }

  // GET: fetch trailer, thumb, and watch providers (TMDB, IMDb, YouTube; OMDb for poster)
  if (event.httpMethod === "GET") {
    const params = event.queryStringParameters || {};
    const imdbId = params.imdbId || "";
    const title = (params.title || "").trim();
    const year = params.year ? String(params.year).replace(/\D/g, "").slice(0, 4) : null;
    const watchRegion = (params.watch_region || "").trim().toUpperCase().slice(0, 2);
    const norm = (id) => (String(id).startsWith("tt") ? id : `tt${id}`);
    const nImdb = norm(imdbId).trim();
    const hasImdb = nImdb && /^tt\d+$/.test(nImdb);
    const hasTitle = title.length > 0;

    if (!hasImdb && !hasTitle) {
      return jsonRes(400, { ok: false, error: "imdbId or title required" }, event);
    }

    let omdb = null;
    let thumb = null;
    let searchTitle = title;
    let searchYear = year;

    if (hasImdb) {
      try {
        omdb = await fetchOMDb(nImdb);
        searchTitle = omdb.Title || title;
        searchYear = searchYear || (omdb.Year && String(omdb.Year).replace(/\D/g, "").slice(0, 4)) || null;
        thumb = omdb.Poster && omdb.Poster !== "N/A" ? omdb.Poster : null;
      } catch (e) {
        // continue without OMDb
      }
    }

    let youtubeId = null;
    let embedUrl = null;
    let services = [];

    // 1. TMDB: poster, title/year for search, trailer key, watch providers (single enrichment pass)
    if (hasImdb) {
      const tmdbKey = process.env.TMDB_API_KEY;
      if (tmdbKey) {
        try {
          const e = await enrichFromTmdb(nImdb, tmdbKey, watchRegion, omdb);
          if (e) {
            if (e.thumb) thumb = e.thumb;
            searchTitle = e.title || searchTitle;
            if (e.year != null) searchYear = String(e.year);
            youtubeId = e.youtubeId;
            services = e.services || [];
          }
        } catch (err) {}
      }
    }

    // 2. YouTube search (plays in our modal) — before IMDb embed, which is often blocked in iframes off-site
    if (!youtubeId && searchTitle) {
      try {
        youtubeId = await fetchTrailerFromYouTubeSearch(searchTitle, searchYear);
      } catch (e) {}
    }

    // 3. IMDb videogallery scrape — last resort; frontend opens in new tab (see app.js), not iframe
    if (!youtubeId && hasImdb) {
      try {
        const html = await fetchHtml(`https://www.imdb.com/title/${nImdb}/videogallery`);
        const match = html.match(/\/video\/(vi\d+)/);
        if (match) {
          embedUrl = `https://www.imdb.com/video/imdb/${match[1]}/imdb/embed?autoplay=true`;
        }
      } catch (e) {}
    }

    const basePayload = {
      thumb: thumb || undefined,
      services: services.length ? services : undefined,
      resolvedTitle: searchTitle || undefined,
      resolvedYear: searchYear || undefined,
    };
    if (youtubeId) {
      return jsonRes(200, { ok: true, youtubeId, ...basePayload }, event);
    }
    if (embedUrl) {
      return jsonRes(200, { ok: true, embedUrl, ...basePayload }, event);
    }

    return jsonRes(404, { ok: false, error: "No trailer found for this title", ...basePayload }, event);
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
  const { imdbId, listId: bodyListId, watch_region: bodyWatch } = body;
  const listId = bodyListId || cookies.bookmarklet_list_id || null;
  if (!imdbId) {
    return jsonRes(400, { ok: false, error: "imdbId required" }, event);
  }

  const norm = (id) => (String(id).startsWith("tt") ? id : `tt${id}`);
  const nImdb = norm(imdbId);
  const watchRegion = String(bodyWatch || body.watchRegion || "").trim().toUpperCase().slice(0, 2);

  let omdbForTmdb = null;
  try {
    omdbForTmdb = await fetchOMDb(nImdb);
  } catch (e) {
    omdbForTmdb = null;
  }

  const tmdbKey = process.env.TMDB_API_KEY;
  let movie = null;

  // 1) TMDB from IMDb id: type, poster, genres, year, providers, trailer key
  if (tmdbKey) {
    try {
      const e = await enrichFromTmdb(nImdb, tmdbKey, watchRegion, omdbForTmdb);
      if (e) {
        let yt = e.youtubeId;
        if (!yt && e.title) {
          try {
            yt = await fetchTrailerFromYouTubeSearch(e.title, e.year);
          } catch (err) {}
        }
        movie = {
          title: e.title,
          year: e.year,
          type: e.type,
          genre: e.genre || "",
          thumb: e.thumb,
          youtubeId: normalizeStoredYoutubeTrailerId(yt),
          imdbId: nImdb,
          services: Array.isArray(e.services) ? e.services : [],
          tmdbId: e.tmdbId,
        };
      }
    } catch (err) {}
  }

  // 2) OMDb fallback when TMDB has no match
  if (!movie) {
    let omdb;
    try {
      omdb = omdbForTmdb || (await fetchOMDb(nImdb));
    } catch (e) {
      return jsonRes(502, { ok: false, error: e.message || "Title not found in TMDB or OMDb" }, event);
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

    let yt = null;
    try {
      yt = await fetchTrailerFromYouTubeSearch(title, year);
    } catch (err) {}

    movie = {
      title,
      year: isNaN(year) ? null : year,
      type: nType,
      genre: genre || "",
      thumb,
      youtubeId: normalizeStoredYoutubeTrailerId(yt),
      imdbId: nImdb,
      services: [],
    };
  }

  const key = movieKey(movie);

  const db = getFirestore(getApp());

  if (listId) {
    const listRef = db.collection("sharedLists").doc(listId);
    const listSnap = await listRef.get();
    if (!listSnap.exists) {
      return jsonRes(404, { ok: false, error: "Shared list not found" }, event);
    }
    const listData = listSnap.data();
    const members = Array.isArray(listData.members) ? listData.members : [];
    if (!members.includes(uid)) {
      return jsonRes(403, { ok: false, error: "Not a member of this shared list" }, event);
    }
    const items = Array.isArray(listData.items) ? [...listData.items] : [];
    const existing = items.find((m) => m.imdbId && norm(m.imdbId) === nImdb)
      || items.find(
          (m) => m.title === movie.title && String(m.year ?? "") === String(movie.year ?? "")
        );
    if (existing) {
      return jsonRes(200, { ok: true, added: false, message: `"${movie.title}" is already in the list` }, event);
    }
    items.push(movie);
    await listRef.update({ items });
    return jsonRes(200, { ok: true, added: true, message: `Added "${movie.title}" to shared list` }, event);
  }

  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();
  const data = userSnap.exists ? userSnap.data() : {};
  const items = Array.isArray(data.items) ? [...data.items] : [];
  const watched = Array.isArray(data.watched) ? data.watched : [];
  const maybeLater = Array.isArray(data.maybeLater) ? data.maybeLater : [];
  const archive = Array.isArray(data.archive) ? data.archive : [];

  let existing = items.find((m) => m.imdbId && norm(m.imdbId) === nImdb);
  if (!existing) {
    existing = items.find(
      (m) => m.title === movie.title && String(m.year ?? "") === String(movie.year ?? "")
    );
  }

  if (existing) {
    if (watched.includes(key) || maybeLater.includes(key) || archive.includes(key)) {
      return jsonRes(200, { ok: true, added: false, message: `"${movie.title}" is already in your list` }, event);
    }
    const idx = items.findIndex((m) => m === existing);
    if (idx >= 0) {
      const needMerge =
        (existing.year == null && movie.year != null) ||
        (!existing.thumb && movie.thumb) ||
        (!existing.genre && movie.genre) ||
        (!isPlayableYoutubeTrailerId(existing.youtubeId) &&
          isPlayableYoutubeTrailerId(movie.youtubeId)) ||
        ((!existing.services || existing.services.length === 0) &&
          movie.services &&
          movie.services.length > 0);
      if (needMerge) {
        if (existing.year == null && movie.year != null) existing.year = movie.year;
        if (!existing.thumb && movie.thumb) existing.thumb = movie.thumb;
        if (!existing.genre && movie.genre) existing.genre = movie.genre;
        if (
          !isPlayableYoutubeTrailerId(existing.youtubeId) &&
          isPlayableYoutubeTrailerId(movie.youtubeId)
        ) {
          existing.youtubeId = movie.youtubeId;
        }
        if ((!existing.services || existing.services.length === 0) && movie.services?.length) {
          existing.services = movie.services;
        }
        if (!existing.imdbId && movie.imdbId) existing.imdbId = movie.imdbId;
        if (movie.tmdbId && !existing.tmdbId) existing.tmdbId = movie.tmdbId;
      }
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
    },
    { merge: true }
  );

  return jsonRes(200, { ok: true, added: true, message: `Added "${movie.title}" to To Watch` }, event);
};
