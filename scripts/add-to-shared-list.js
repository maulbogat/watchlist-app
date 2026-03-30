/**
 * Add a title to a shared list (titleRegistry + { registryId } row).
 * Resolves from titleRegistry, user/shared rows, watchlist-backup.json, or OMDb (IMDb id / title).
 *
 * Run: node scripts/add-to-shared-list.js "Requiem for a Dream" "Our list"
 * Or:  node scripts/add-to-shared-list.js tt10919420 "Our list"
 */
import "dotenv/config";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import https from "https";
import { getDb } from "./lib/admin-init.mjs";
import { loadAllRegistryMap, hydrateListRow } from "./lib/registry-query.mjs";
import { registryDocIdFromItem, payloadForRegistry, listKey } from "../lib/registry-id.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

function fetchOMDbByImdbId(imdbId) {
  const apiKey = process.env.OMDB_API_KEY;
  if (!apiKey) return Promise.reject(new Error("OMDB_API_KEY required"));
  const nImdb = String(imdbId).startsWith("tt") ? imdbId : `tt${imdbId}`;
  const url = `https://www.omdbapi.com/?i=${encodeURIComponent(nImdb)}&apikey=${apiKey}`;
  return fetchJson(url);
}

async function fetchOMDbByTitle(title) {
  const apiKey = process.env.OMDB_API_KEY;
  if (!apiKey) return null;
  const url = `https://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${apiKey}`;
  try {
    const json = await fetchJson(url);
    if (json.Response === "False") return null;
    return json;
  } catch (_) {
    return null;
  }
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (json.Response === "False") reject(new Error(json.Error || "OMDb lookup failed"));
            else resolve(json);
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

function omdbToMovie(omdb, imdbId) {
  const title = omdb.Title || "Unknown";
  let year = null;
  const yearStr = String(omdb.Year || "").trim();
  if (yearStr && yearStr !== "N/A") {
    const digits = yearStr.replace(/\D/g, "").slice(0, 4);
    if (digits.length >= 4) year = parseInt(digits, 10);
  }
  const nType = (omdb.Type || "").toLowerCase() === "series" ? "show" : "movie";
  const genre = omdb.Genre || "";
  const thumb = omdb.Poster && omdb.Poster !== "N/A" ? omdb.Poster : null;
  const nImdb = imdbId || omdb.imdbID || "";
  return {
    title,
    year: isNaN(year) ? null : year,
    type: nType,
    genre: genre || "",
    youtubeId: null,
    imdbId: nImdb ? (String(nImdb).startsWith("tt") ? nImdb : `tt${nImdb}`) : null,
    thumb,
    services: [],
  };
}

function normalizeMovie(m) {
  const { status, ...rest } = m;
  return rest;
}

async function findMovie(db, titleArg, regMap) {
  const arg = String(titleArg).trim();
  const search = arg.toLowerCase();
  const matchExact = (m) => String(m.title || "").trim().toLowerCase() === search;
  const matchFuzzy = (m) => {
    const t = String(m.title || "").trim().toLowerCase();
    return t.includes(search) || search.includes(t);
  };

  if (/^tt\d+$/i.test(arg)) {
    try {
      const omdb = await fetchOMDbByImdbId(arg);
      return normalizeMovie(omdbToMovie(omdb, arg));
    } catch (e) {
      throw new Error(`OMDb lookup failed: ${e.message}. Set OMDB_API_KEY for IMDb ID.`);
    }
  }

  for (const match of [matchExact, matchFuzzy]) {
    const fromReg = [...regMap.values()].find(match);
    if (fromReg) return normalizeMovie(fromReg);

    const usersSnap = await db.collection("users").get();
    for (const d of usersSnap.docs) {
      const items = d.data().items || [];
      const m = items.map((row) => hydrateListRow(row, regMap)).find((h) => h && match(h));
      if (m) return normalizeMovie(m);
    }

    const listsSnap = await db.collection("sharedLists").get();
    for (const d of listsSnap.docs) {
      const items = d.data().items || [];
      const m = items.map((row) => hydrateListRow(row, regMap)).find((h) => h && match(h));
      if (m) return normalizeMovie(m);
    }

    try {
      const backup = JSON.parse(readFileSync(join(rootDir, "watchlist-backup.json"), "utf-8"));
      const items = Array.isArray(backup) ? backup : backup.items || [];
      const m = items.find(match);
      if (m) return normalizeMovie(m);
    } catch (_) {}
  }

  const omdb = await fetchOMDbByTitle(arg);
  if (omdb) return normalizeMovie(omdbToMovie(omdb));

  return null;
}

async function main() {
  const db = getDb();
  const regMap = await loadAllRegistryMap(db);
  const [titleArg, listIdOrName] = process.argv.slice(2);
  if (!titleArg || !listIdOrName) {
    console.error('Usage: node scripts/add-to-shared-list.js "Requiem for a Dream" "Our list"');
    process.exit(1);
  }

  let movie;
  try {
    movie = await findMovie(db, titleArg, regMap);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  if (!movie) {
    console.error(`"${titleArg}" not found. Set OMDB_API_KEY to fetch from OMDb by title.`);
    process.exit(1);
  }

  const rid = movie.registryId || registryDocIdFromItem(movie);
  const payload = payloadForRegistry({ ...movie, registryId: rid });
  await db.collection("titleRegistry").doc(rid).set(payload, { merge: true });

  let listId = listIdOrName;
  if (listIdOrName.length > 20 || listIdOrName.includes(" ")) {
    const listsSnap = await db.collection("sharedLists").get();
    const match = listsSnap.docs.find((d) => {
      const name = (d.data().name || "").toLowerCase();
      return name.includes(listIdOrName.toLowerCase()) || listIdOrName.toLowerCase().includes(name);
    });
    if (!match) {
      console.error(`No shared list found matching "${listIdOrName}"`);
      process.exit(1);
    }
    listId = match.id;
    console.log(`Found list: ${match.data().name} (${listId})`);
  }

  const listSnap = await db.collection("sharedLists").doc(listId).get();
  if (!listSnap.exists) {
    console.error("Shared list not found");
    process.exit(1);
  }
  const listData = listSnap.data();
  const listItems = Array.isArray(listData.items) ? [...listData.items] : [];
  const listWatched = new Set(listData.watched || []);
  const listMaybeLater = new Set(listData.maybeLater || []);

  const key = rid;
  const existingKeys = new Set(listItems.map((m) => (m.registryId ? m.registryId : listKey(m))));
  if (existingKeys.has(key)) {
    console.log(`"${movie.title}" already in shared list (${key}).`);
    return;
  }

  listItems.push({ registryId: rid });
  await db
    .collection("sharedLists")
    .doc(listId)
    .set(
      {
        items: listItems,
        watched: [...listWatched],
        maybeLater: [...listMaybeLater],
      },
      { merge: true }
    );

  console.log(`Added "${movie.title}" to shared list (registry ${rid}).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
