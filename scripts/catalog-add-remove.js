/**
 * Add/remove catalog items in a Firestore backup JSON.
 * Run: node scripts/catalog-add-remove.js
 *
 * Edits backups/firestore-backup-migrated.json
 */
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const backupPath = join(rootDir, "backups", "firestore-backup-migrated.json");

const REMOVE_KEYS = new Set(["מי שחלם|2005", "האחת|2023"]);

const TO_ADD = [
  {
    title: "Dogs of War",
    year: 1980,
    type: "movie",
    genre: "War / Action",
    youtubeId: null,
    imdbId: "tt0080655",
    services: [],
  },
  {
    title: "Beaufort",
    year: 2007,
    type: "movie",
    genre: "War / Drama",
    youtubeId: null,
    imdbId: "tt0833085",
    services: [],
  },
];

function movieKey(m) {
  return `${m.title}|${m.year ?? ""}`;
}

function filterItemArrays(obj) {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj.items)) {
    obj.items = obj.items.filter((m) => !REMOVE_KEYS.has(movieKey(m)));
  }
  for (const k of ["watched", "maybeLater", "archive"]) {
    if (Array.isArray(obj[k])) {
      obj[k] = obj[k].filter((key) => !REMOVE_KEYS.has(key));
    }
  }
}

/** Remove status keys from any nested string arrays (handles Unicode variants). */
function stripKeysFromAllArrays(node, depth = 0) {
  if (depth > 20 || node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (let i = node.length - 1; i >= 0; i--) {
      const el = node[i];
      if (typeof el === "string") {
        for (const rk of REMOVE_KEYS) {
          if (el === rk || el.replace(/\s/g, "") === rk.replace(/\s/g, "")) {
            node.splice(i, 1);
            break;
          }
        }
      } else if (typeof el === "object") {
        stripKeysFromAllArrays(el, depth + 1);
      }
    }
    return;
  }
  if (typeof node === "object") {
    for (const k of Object.keys(node)) {
      stripKeysFromAllArrays(node[k], depth + 1);
    }
  }
}

const backup = JSON.parse(readFileSync(backupPath, "utf-8"));

if (backup.catalog?.movies?.items) {
  const items = backup.catalog.movies.items;
  backup.catalog.movies.items = items.filter((m) => !REMOVE_KEYS.has(movieKey(m)));
  for (const movie of TO_ADD) {
    const exists = backup.catalog.movies.items.some(
      (m) => m.title === movie.title && String(m.year) === String(movie.year)
    );
    if (!exists) {
      backup.catalog.movies.items.push(movie);
      console.log(`Added catalog: ${movie.title} (${movie.year})`);
    } else {
      console.log(`Skip add (exists): ${movie.title} (${movie.year})`);
    }
  }
}

if (backup.users && typeof backup.users === "object") {
  for (const [uid, doc] of Object.entries(backup.users)) {
    if (!doc || typeof doc !== "object") continue;
    filterItemArrays(doc);
    stripKeysFromAllArrays(doc);
    console.log(`Cleaned user: ${uid}`);
  }
}

if (backup.sharedLists && typeof backup.sharedLists === "object") {
  for (const [id, doc] of Object.entries(backup.sharedLists)) {
    if (!doc || typeof doc !== "object") continue;
    filterItemArrays(doc);
    stripKeysFromAllArrays(doc);
    console.log(`Cleaned shared list: ${id}`);
  }
}

backup.exportedAt = new Date().toISOString();
writeFileSync(backupPath, JSON.stringify(backup, null, 2), "utf-8");
console.log(`\nWrote ${backupPath}`);
