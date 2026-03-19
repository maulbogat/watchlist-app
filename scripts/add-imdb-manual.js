/**
 * Add manual imdbIds to backup file. Updates firestore-backup-migrated.json.
 * Run: node scripts/add-imdb-manual.js
 */
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const backupPath = join(rootDir, "backups", "firestore-backup-migrated.json");

const MANUAL_IMDB = [
  { title: "Runt", year: 2021, imdbId: "tt6988296" },
  { title: "Big Stan", year: 2007, imdbId: "tt0490086" },
  { title: "You've Got Mail", year: 1998, imdbId: "tt0128853" },
  { title: "Open Water", year: 2003, imdbId: "tt0374102" },
  { title: "Adios Buenos Aires", year: 2014, imdbId: "tt27042638" },
  { title: "The Three Amigos", year: 1986, imdbId: "tt0092086" },
  { title: "Heweliusz", year: 2024, imdbId: "tt32253092" },
  { title: "כלבים לא נובחים בירוק", year: 1996, imdbId: "tt0116786" },
  { title: "המזח", year: 2025, imdbId: "tt28511459" },
  { title: "זה לא הגיל", year: 2019, imdbId: "tt11486960" },
  { title: "מטומטמת", year: 2016, imdbId: "tt6575296" },
  { title: "אנחנו המהפכה", year: 2020, imdbId: "tt14649040" },
];

function norm(s) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\u2018\u2019\u0027]/g, "'");
}

function match(m, spec) {
  return norm(m.title) === norm(spec.title) && String(m.year ?? "") === String(spec.year ?? "");
}

const backup = JSON.parse(readFileSync(backupPath, "utf-8"));
const items = backup.catalog?.movies?.items;
if (!items) {
  console.error("No catalog.movies.items in backup");
  process.exit(1);
}

let updated = 0;
for (const spec of MANUAL_IMDB) {
  const idx = items.findIndex((m) => match(m, spec));
  if (idx >= 0) {
    items[idx].imdbId = spec.imdbId.startsWith("tt") ? spec.imdbId : `tt${spec.imdbId}`;
    console.log(`Added imdbId to ${spec.title} (${spec.year})`);
    updated++;
  } else {
    console.warn(`Not found: ${spec.title} (${spec.year})`);
  }
}

writeFileSync(backupPath, JSON.stringify(backup, null, 2), "utf-8");
console.log(`\nUpdated ${updated} items in ${backupPath}`);
