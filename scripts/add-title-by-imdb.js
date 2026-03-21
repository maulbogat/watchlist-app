/**
 * Add one title to titleRegistry by IMDb id (TMDB enrichment: thumb, trailer, tmdbId, services).
 *
 * Run: node scripts/add-title-by-imdb.js tt28000275
 * Requires: .env TMDB_API_KEY, OMDB_API_KEY; serviceAccountKey.json or FIREBASE_SERVICE_ACCOUNT
 * Optional: WATCH_REGION (default IL) for provider chips
 */
import "dotenv/config";
import https from "https";
import { getDb } from "./lib/admin-init.mjs";
import { normalizeStoredYoutubeTrailerId } from "../lib/youtube-trailer-id.js";
import { registryDocIdFromItem, payloadForRegistry, normalizeImdbId } from "../lib/registry-id.js";

const TMDB_IMG = "https://image.tmdb.org/t/p/w500";

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(data);
            if (res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode}`));
              return;
            }
            if (j.success === false) {
              reject(new Error(j.status_message || "TMDB error"));
              return;
            }
            resolve(j);
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

function pickYoutubeTrailerKey(results) {
  const r = results || [];
  const preferred = (t) => r.find((v) => v.site === "YouTube" && v.key && v.type === t);
  const key =
    preferred("Trailer") ||
    preferred("Teaser") ||
    r.find((v) => v.site === "YouTube" && v.key && (v.type === "Clip" || v.type === "Featurette")) ||
    r.find((v) => v.site === "YouTube" && v.key);
  return key?.key || null;
}

function pickTmdbFindEntry(find, omdbHint) {
  const movie = find.movie_results?.[0];
  const tv = find.tv_results?.[0];
  if (!movie && !tv) return { mediaType: null, id: null };
  if (!movie) return { mediaType: "tv", id: tv.id };
  if (!tv) return { mediaType: "movie", id: movie.id };
  const t = omdbHint && String(omdbHint.Type || "").toLowerCase();
  if (t === "movie") return { mediaType: "movie", id: movie.id };
  if (t === "series" || t === "episode") return { mediaType: "tv", id: tv.id };
  return { mediaType: "tv", id: tv.id };
}

async function fetchOMDb(imdbId) {
  const apiKey = process.env.OMDB_API_KEY;
  if (!apiKey) throw new Error("OMDB_API_KEY missing in .env");
  const id = String(imdbId).startsWith("tt") ? imdbId : `tt${imdbId}`;
  const url = `https://www.omdbapi.com/?i=${encodeURIComponent(id)}&apikey=${apiKey}`;
  const json = await fetchJson(url);
  if (json.Response === "False") throw new Error(json.Error || "OMDb failed");
  return json;
}

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
    tmdbMedia: mediaType,
    type: mediaType === "movie" ? "movie" : "show",
    title: title || "Unknown",
    year,
    thumb,
    genre,
    youtubeId,
    services,
  };
}

function normImdb(id) {
  return normalizeImdbId(id) || "";
}

async function main() {
  const imdbRaw = process.argv[2];
  if (!imdbRaw) {
    console.error("Usage: node scripts/add-title-by-imdb.js tt12345678");
    process.exit(1);
  }
  const imdbId = normImdb(imdbRaw);
  if (!/^tt\d+$/.test(imdbId)) {
    console.error("Invalid IMDb id:", imdbRaw);
    process.exit(1);
  }

  const tmdbKey = process.env.TMDB_API_KEY;
  if (!tmdbKey) {
    console.error("Set TMDB_API_KEY in .env");
    process.exit(1);
  }

  const watchRegion = (process.env.WATCH_REGION || "IL").trim().toUpperCase().slice(0, 2);

  let omdb = null;
  try {
    omdb = await fetchOMDb(imdbId);
  } catch (e) {
    console.warn("OMDb:", e.message || e);
  }

  const e = await enrichFromTmdb(imdbId, tmdbKey, watchRegion, omdb);
  if (!e) {
    console.error("TMDB has no movie/TV for", imdbId);
    process.exit(1);
  }

  const db = getDb();

  const snap = await db.collection("titleRegistry").get();
  for (const d of snap.docs) {
    const data = d.data();
    if (normalizeImdbId(data.imdbId) === imdbId) {
      console.error(`titleRegistry already has ${d.id} with imdbId ${imdbId}.`);
      process.exit(1);
    }
  }

  const movie = {
    title: e.title,
    year: e.year,
    type: e.type,
    genre: e.genre || "",
    thumb: e.thumb,
    youtubeId: normalizeStoredYoutubeTrailerId(e.youtubeId),
    imdbId,
    services: Array.isArray(e.services) ? e.services : [],
    tmdbId: e.tmdbId,
    tmdbMedia: e.tmdbMedia,
  };

  const rid = registryDocIdFromItem(movie);
  const payload = payloadForRegistry({ ...movie, registryId: rid });
  await db.collection("titleRegistry").doc(rid).set(payload, { merge: true });

  console.log(`Added titleRegistry/${rid}: "${movie.title}" (${movie.year ?? "—"})  imdb=${imdbId}  tmdbId=${movie.tmdbId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
