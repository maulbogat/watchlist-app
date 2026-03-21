/**
 * For every item with tmdbId, fetch TMDB /movie/{id} or /tv/{id} and verify that
 * stored title, year, type (movie/show), and genre match TMDB.
 *
 * Run: node scripts/verify-tmdb-metadata.js [backup.json]
 * Default: backups/firestore-backup-migrated.json (or firestore-backup.json)
 *
 * Requires: TMDB_API_KEY in .env
 * Report: backups/verify-tmdb-metadata-report.txt
 *
 * Uses tmdbMedia when "movie" or "tv"; otherwise disambiguates like sync-metadata
 * (append_to_response=videos; prefer endpoint with a YouTube trailer when hint is missing).
 * Genre comparison normalizes order (split/sort/join) so "Action / Drama" matches "Drama / Action".
 */
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import https from "https";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const DELAY_MS = 260;

function numTmdbId(m) {
  const t = m?.tmdbId;
  if (t == null || t === "") return null;
  const n = Number(t);
  return Number.isNaN(n) ? null : n;
}

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

function formatMovie(d) {
  if (!d?.id) return null;
  let year = null;
  if (d.release_date && String(d.release_date).length >= 4) {
    year = parseInt(String(d.release_date).slice(0, 4), 10);
  }
  if (Number.isNaN(year)) year = null;
  const genres = (d.genres || []).map((g) => g.name).filter(Boolean);
  return {
    title: d.title || d.original_title || "",
    year,
    type: "movie",
    genre: genres.join(" / "),
    tmdbMedia: "movie",
  };
}

function formatTv(d) {
  if (!d?.id) return null;
  let year = null;
  if (d.first_air_date && String(d.first_air_date).length >= 4) {
    year = parseInt(String(d.first_air_date).slice(0, 4), 10);
  }
  if (Number.isNaN(year)) year = null;
  const genres = (d.genres || []).map((g) => g.name).filter(Boolean);
  return {
    title: d.name || d.original_name || "",
    year,
    type: "show",
    genre: genres.join(" / "),
    tmdbMedia: "tv",
  };
}

async function fetchDetailsByTmdbId(id, apiKey, hint) {
  const base = `https://api.themoviedb.org/3`;
  const v = "append_to_response=videos";
  const movieUrl = `${base}/movie/${id}?${v}&api_key=${encodeURIComponent(apiKey)}`;
  const tvUrl = `${base}/tv/${id}?${v}&api_key=${encodeURIComponent(apiKey)}`;

  if (hint === "tv") {
    try {
      const d = await fetchJson(tvUrl);
      return formatTv(d);
    } catch {
      return null;
    }
  }
  if (hint === "movie") {
    try {
      const d = await fetchJson(movieUrl);
      return formatMovie(d);
    } catch {
      return null;
    }
  }
  let movieD = null;
  try {
    movieD = await fetchJson(movieUrl);
  } catch {
    movieD = null;
  }
  if (movieD) {
    const m = formatMovie(movieD);
    if (youtubeIdFromDetail(movieD)) return m;
  }
  try {
    const tvD = await fetchJson(tvUrl);
    const t = formatTv(tvD);
    if (youtubeIdFromDetail(tvD)) return t;
    if (movieD) return formatMovie(movieD);
    return t;
  } catch {
    return movieD ? formatMovie(movieD) : null;
  }
}

function normTitle(s) {
  return String(s ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

function normYear(y) {
  if (y == null || y === "") return null;
  if (typeof y === "number") {
    return Number.isNaN(y) ? null : y;
  }
  const s = String(y).trim();
  if (!s) return null;
  const n = parseInt(s.slice(0, 4), 10);
  return Number.isNaN(n) ? null : n;
}

/** Stored type vs TMDB: we only accept movie | show */
function normStoredType(t) {
  return t === "show" ? "show" : "movie";
}

/** Same genre list, order-independent */
function normGenre(g) {
  if (g == null) return "";
  const parts = String(g)
    .split("/")
    .map((x) => x.trim())
    .filter(Boolean);
  parts.sort((a, b) => a.localeCompare(b, "en"));
  return parts.join(" / ");
}

function walkAllItems(backup, fn) {
  for (const [rid, row] of Object.entries(backup.titleRegistry || {})) {
    if (!row || typeof row !== "object") continue;
    const arr = [row];
    fn(arr, 0, `titleRegistry:${rid}`);
  }
  for (const [uid, doc] of Object.entries(backup.users || {})) {
    if (!Array.isArray(doc?.items)) continue;
    for (let i = 0; i < doc.items.length; i++) fn(doc.items, i, `user:${uid}#${i}`);
  }
  for (const [lid, doc] of Object.entries(backup.sharedLists || {})) {
    if (!Array.isArray(doc?.items)) continue;
    for (let i = 0; i < doc.items.length; i++) fn(doc.items, i, `shared:${lid}#${i}`);
  }
  if (backup.userPersonalLists && typeof backup.userPersonalLists === "object") {
    for (const [uid, lists] of Object.entries(backup.userPersonalLists)) {
      if (!lists || typeof lists !== "object") continue;
      for (const [plid, doc] of Object.entries(lists)) {
        if (!Array.isArray(doc?.items)) continue;
        for (let i = 0; i < doc.items.length; i++) fn(doc.items, i, `personal:${uid}/${plid}#${i}`);
      }
    }
  }
}

function hintForItem(m) {
  return m.tmdbMedia === "tv" || m.tmdbMedia === "movie" ? m.tmdbMedia : null;
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const defaultPath = join(rootDir, "backups", "firestore-backup-migrated.json");
  const altPath = join(rootDir, "backups", "firestore-backup.json");
  let backupPath = args[0] || (existsSync(defaultPath) ? defaultPath : altPath);

  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) {
    console.error("Set TMDB_API_KEY in .env");
    process.exit(1);
  }

  let backup;
  try {
    backup = JSON.parse(readFileSync(backupPath, "utf-8"));
  } catch (e) {
    console.error("Cannot read", backupPath, e.message);
    process.exit(1);
  }

  /** @type {Map<string, { meta: object | null, err?: string }>} */
  const cache = new Map();
  const cacheKey = (id, hint) => `${id}:${hint ?? "auto"}`;

  /** Collect unique (id, hint) pairs we need to fetch */
  const pairs = [];
  const seen = new Set();
  walkAllItems(backup, (arr, i, _loc) => {
    const m = arr[i];
    const id = numTmdbId(m);
    if (id == null) return;
    const h = hintForItem(m);
    const key = cacheKey(id, h);
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push({ id, hint: h });
  });

  console.log(`Backup: ${backupPath}`);
  console.log(`Unique tmdbId fetches: ${pairs.length}`);

  for (const { id, hint } of pairs) {
    const key = cacheKey(id, hint);
    try {
      const meta = await fetchDetailsByTmdbId(id, apiKey, hint);
      cache.set(key, { meta });
    } catch (e) {
      cache.set(key, { meta: null, err: String(e.message || e) });
    }
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  const mismatches = [];
  const okRows = [];
  const fetchErrors = [];

  walkAllItems(backup, (arr, i, loc) => {
    const m = arr[i];
    const id = numTmdbId(m);
    if (id == null) return;

    const h = hintForItem(m);
    const key = cacheKey(id, h);
    const entry = cache.get(key);
    if (!entry || entry.err) {
      fetchErrors.push({
        loc,
        tmdbId: id,
        hint: h ?? "auto",
        err: entry?.err || "missing cache",
        title: m.title,
      });
      return;
    }
    const tmdb = entry.meta;
    if (!tmdb) {
      fetchErrors.push({
        loc,
        tmdbId: id,
        hint: h ?? "auto",
        err: "no movie/tv details",
        title: m.title,
      });
      return;
    }

    const issues = [];
    const st = normTitle(m.title);
    const tt = normTitle(tmdb.title);
    if (st !== tt) {
      issues.push({ field: "title", stored: m.title, tmdb: tmdb.title });
    }

    const sy = normYear(m.year);
    const ty = normYear(tmdb.year);
    if (sy !== ty) {
      issues.push({ field: "year", stored: m.year, tmdb: tmdb.year });
    }

    if (normStoredType(m.type) !== tmdb.type) {
      issues.push({ field: "type", stored: m.type, tmdb: tmdb.type });
    }

    const sg = normGenre(m.genre);
    const tg = normGenre(tmdb.genre);
    if (sg !== tg) {
      issues.push({
        field: "genre",
        stored: m.genre || "",
        tmdb: tmdb.genre,
      });
    }

    if (issues.length) {
      mismatches.push({ loc, tmdbId: id, imdbId: m.imdbId, issues });
    } else {
      okRows.push(loc);
    }
  });

  const reportPath = join(rootDir, "backups", "verify-tmdb-metadata-report.txt");
  const lines = [
    `verify-tmdb-metadata`,
    `Generated: ${new Date().toISOString()}`,
    `Source: ${backupPath}`,
    ``,
    `Rows with tmdbId checked: ${okRows.length + mismatches.length}`,
    `Match TMDB: ${okRows.length}`,
    `Mismatches: ${mismatches.length}`,
    `Fetch errors (could not load TMDB): ${fetchErrors.length}`,
    ``,
  ];

  if (fetchErrors.length) {
    lines.push(`=== Fetch errors ===`, ``);
    for (const e of fetchErrors) {
      lines.push(
        `  ${e.loc}  tmdbId=${e.tmdbId} hint=${e.hint}  "${e.title ?? ""}"  (${e.err})`
      );
    }
    lines.push(``);
  }

  if (mismatches.length) {
    lines.push(`=== Field mismatches (stored vs TMDB) ===`, ``);
    for (const row of mismatches) {
      lines.push(
        `  ${row.loc}  tmdbId=${row.tmdbId}${row.imdbId ? ` imdbId=${row.imdbId}` : ""}`
      );
      for (const iss of row.issues) {
        lines.push(
          `    ${iss.field}: stored=${JSON.stringify(iss.stored)}  tmdb=${JSON.stringify(iss.tmdb)}`
        );
      }
      lines.push(``);
    }
  } else {
    lines.push(`No field mismatches for items with a successful TMDB fetch.`, ``);
  }

  lines.push(
    `---`,
    `To fix mismatches in a backup file, run:`,
    `  node scripts/sync-metadata-from-tmdb-id.js ${backupPath}`,
    `(Or use backfill-tmdb-from-imdb.js if imdbId is the source of truth.)`
  );

  writeFileSync(reportPath, lines.join("\n"), "utf-8");
  console.log(lines.slice(0, 12).join("\n"));
  console.log(`\nFull report: ${reportPath}`);
  process.exit(mismatches.length || fetchErrors.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
