/**
 * For every item with tmdbId, fetch TMDB watch/providers and store per-region data.
 *
 * Data model:
 *   - items[].servicesByRegion: { "IL": ["Netflix", ...], "US": [...] }
 *   - items[].services: set to the list owner's region (users) or cleared for shared lists
 *     (UI uses servicesForMovie() which prefers servicesByRegion[user country]).
 *
 * Regions:
 *   - users/*: each user's items get providers for that user's `country` (Firestore field),
 *     or DEFAULT_WATCH_REGION / IL.
 *   - titleRegistry: REGISTRY_WATCH_REGION or CATALOG_WATCH_REGION (default IL).
 *   - sharedLists/*: for each member uid, look up users[uid].country; fetch every distinct
 *     region so all members see correct chips.
 *
 * Run: node scripts/sync-services-from-tmdb.js [backup.json] [--dry-run]
 * Requires: TMDB_API_KEY in .env
 * Report: backups/sync-services-from-tmdb-report.txt
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

function normRegion(r) {
  if (r == null || r === "") return null;
  const s = String(r).trim().toUpperCase();
  if (s.length < 2) return null;
  return s.slice(0, 2);
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

function extractProviders(pdata, region) {
  const r = normRegion(region);
  if (!r) return [];
  const reg = pdata.results?.[r];
  if (!reg) return [];
  const names = new Set();
  for (const arr of [reg.flatrate, reg.rent, reg.buy].filter(Boolean)) {
    for (const p of arr) {
      if (p.provider_name) names.add(p.provider_name);
    }
  }
  return [...names];
}

async function resolveMediaType(id, apiKey, hint) {
  if (hint === "movie" || hint === "tv") return hint;
  const base = `https://api.themoviedb.org/3`;
  try {
    await fetchJson(`${base}/movie/${id}?api_key=${encodeURIComponent(apiKey)}`);
    return "movie";
  } catch {
    /* try tv */
  }
  try {
    await fetchJson(`${base}/tv/${id}?api_key=${encodeURIComponent(apiKey)}`);
    return "tv";
  } catch {
    return null;
  }
}

async function fetchProvidersFor(id, media, region, apiKey) {
  if (!media) return [];
  const url = `https://api.themoviedb.org/3/${media}/${id}/watch/providers?api_key=${encodeURIComponent(apiKey)}`;
  const pdata = await fetchJson(url);
  return extractProviders(pdata, region);
}

function isBareRegistryRef(m) {
  if (!m || typeof m !== "object") return true;
  const k = Object.keys(m);
  return k.length === 1 && k[0] === "registryId";
}

function walkAllItemsWithTmdb(backup, fn) {
  for (const [rid, row] of Object.entries(backup.titleRegistry || {})) {
    const m = row;
    if (m && typeof m === "object" && numTmdbId(m) != null) fn(m, `titleRegistry:${rid}`);
  }
  for (const [uid, doc] of Object.entries(backup.users || {})) {
    if (!Array.isArray(doc?.items)) continue;
    for (const m of doc.items) {
      if (!isBareRegistryRef(m) && numTmdbId(m) != null) fn(m, `user:${uid}`);
    }
  }
  for (const [lid, doc] of Object.entries(backup.sharedLists || {})) {
    if (!Array.isArray(doc?.items)) continue;
    for (const m of doc.items) {
      if (!isBareRegistryRef(m) && numTmdbId(m) != null) fn(m, `shared:${lid}`);
    }
  }
  if (backup.userPersonalLists && typeof backup.userPersonalLists === "object") {
    for (const [uid, lists] of Object.entries(backup.userPersonalLists)) {
      if (!lists || typeof lists !== "object") continue;
      for (const [plid, doc] of Object.entries(lists)) {
        if (!Array.isArray(doc?.items)) continue;
        for (const m of doc.items) {
          if (!isBareRegistryRef(m) && numTmdbId(m) != null) fn(m, `personal:${uid}/${plid}`);
        }
      }
    }
  }
}

function buildHintById(backup) {
  const hintById = new Map();
  walkAllItemsWithTmdb(backup, (m) => {
    const id = numTmdbId(m);
    if (id == null) return;
    const h = m.tmdbMedia === "tv" || m.tmdbMedia === "movie" ? m.tmdbMedia : null;
    if (!hintById.has(id)) hintById.set(id, h);
    else if (h && !hintById.get(id)) hintById.set(id, h);
  });
  return hintById;
}

function regionsForSharedList(backup, listDoc, defaultRegion) {
  const members = Array.isArray(listDoc.members) ? listDoc.members : [];
  const regions = new Set();
  for (const uid of members) {
    const c = backup.users?.[uid]?.country;
    const r = normRegion(c) || defaultRegion;
    regions.add(r);
  }
  if (regions.size === 0) regions.add(defaultRegion);
  return [...regions];
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--dry-run");
  const dryRun = process.argv.includes("--dry-run");

  const defaultPath = join(rootDir, "backups", "firestore-backup-migrated.json");
  const altPath = join(rootDir, "backups", "firestore-backup.json");
  let backupPath = args[0] || (existsSync(defaultPath) ? defaultPath : altPath);

  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) {
    console.error("Set TMDB_API_KEY in .env");
    process.exit(1);
  }

  const defaultRegion = normRegion(process.env.DEFAULT_WATCH_REGION) || "IL";
  const registryRegion =
    normRegion(process.env.REGISTRY_WATCH_REGION || process.env.CATALOG_WATCH_REGION) || defaultRegion;

  let backup;
  try {
    backup = JSON.parse(readFileSync(backupPath, "utf-8"));
  } catch (e) {
    console.error("Cannot read", backupPath, e.message);
    process.exit(1);
  }

  const hintById = buildHintById(backup);
  const uniqueIds = [...hintById.keys()].sort((a, b) => a - b);

  console.log(`Backup: ${backupPath}`);
  console.log(`Unique tmdbIds: ${uniqueIds.length}`);
  console.log(`Default region: ${defaultRegion}, titleRegistry region: ${registryRegion}`);
  if (dryRun) {
    console.log("[--dry-run] No TMDB calls / no file write.");
    process.exit(0);
  }

  /** @type {Map<number, 'movie'|'tv'|null>} */
  const mediaById = new Map();
  for (const id of uniqueIds) {
    try {
      const media = await resolveMediaType(id, apiKey, hintById.get(id));
      mediaById.set(id, media);
    } catch {
      mediaById.set(id, null);
    }
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  /** Collect (id, region) pairs we need */
  const pairSet = new Set();
  const addPair = (id, region) => {
    const r = normRegion(region) || defaultRegion;
    pairSet.add(`${id}\t${r}`);
  };

  for (const id of uniqueIds) {
    addPair(id, registryRegion);
  }
  for (const doc of Object.values(backup.users || {})) {
    const r = normRegion(doc.country) || defaultRegion;
    for (const m of doc.items || []) {
      if (isBareRegistryRef(m)) continue;
      if (numTmdbId(m) != null) addPair(numTmdbId(m), r);
    }
  }
  for (const doc of Object.values(backup.sharedLists || {})) {
    for (const r of regionsForSharedList(backup, doc, defaultRegion)) {
      for (const m of doc.items || []) {
        if (isBareRegistryRef(m)) continue;
        const id = numTmdbId(m);
        if (id != null) addPair(id, r);
      }
    }
  }
  if (backup.userPersonalLists && typeof backup.userPersonalLists === "object") {
    for (const [uid, lists] of Object.entries(backup.userPersonalLists)) {
      const r = normRegion(backup.users?.[uid]?.country) || defaultRegion;
      for (const doc of Object.values(lists)) {
        for (const m of doc.items || []) {
          if (isBareRegistryRef(m)) continue;
          const id = numTmdbId(m);
          if (id != null) addPair(id, r);
        }
      }
    }
  }

  const pairs = [...pairSet].map((s) => {
    const [idStr, reg] = s.split("\t");
    return { id: Number(idStr), region: reg };
  });

  /** @type {Map<string, string[]>} */
  const cache = new Map();
  const errors = [];
  for (const { id, region } of pairs) {
    const media = mediaById.get(id);
    const key = `${id}|${region}`;
    if (cache.has(key)) continue;
    try {
      if (!media) {
        cache.set(key, []);
        continue;
      }
      const names = await fetchProvidersFor(id, media, region, apiKey);
      cache.set(key, names);
    } catch (e) {
      errors.push({ id, region, err: String(e.message || e) });
      cache.set(key, []);
    }
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  let userRows = 0;
  let registryRows = 0;
  let sharedRows = 0;

  for (const row of Object.values(backup.titleRegistry || {})) {
    const m = row;
    if (!m || typeof m !== "object") continue;
    const id = numTmdbId(m);
    if (id == null) continue;
    const names = cache.get(`${id}|${registryRegion}`) ?? [];
    const prev =
      m.servicesByRegion && typeof m.servicesByRegion === "object" ? { ...m.servicesByRegion } : {};
    prev[registryRegion] = names;
    Object.assign(m, { servicesByRegion: prev, services: names });
    registryRows++;
  }

  for (const [uid, doc] of Object.entries(backup.users || {})) {
    if (!Array.isArray(doc.items)) continue;
    const region = normRegion(doc.country) || defaultRegion;
    for (let i = 0; i < doc.items.length; i++) {
      const m = doc.items[i];
      if (isBareRegistryRef(m)) continue;
      const id = numTmdbId(m);
      if (id == null) continue;
      const names = cache.get(`${id}|${region}`) ?? [];
      const prev =
        m.servicesByRegion && typeof m.servicesByRegion === "object" ? { ...m.servicesByRegion } : {};
      prev[region] = names;
      Object.assign(m, { servicesByRegion: prev, services: names });
      userRows++;
    }
  }

  for (const doc of Object.values(backup.sharedLists || {})) {
    if (!Array.isArray(doc.items)) continue;
    const regions = regionsForSharedList(backup, doc, defaultRegion);
    for (let i = 0; i < doc.items.length; i++) {
      const m = doc.items[i];
      if (isBareRegistryRef(m)) continue;
      const id = numTmdbId(m);
      if (id == null) continue;
      const prev =
        m.servicesByRegion && typeof m.servicesByRegion === "object" ? { ...m.servicesByRegion } : {};
      for (const r of regions) {
        const names = cache.get(`${id}|${r}`) ?? [];
        prev[r] = names;
      }
      Object.assign(m, {
        servicesByRegion: prev,
        services: [],
      });
      sharedRows++;
    }
  }

  if (backup.userPersonalLists && typeof backup.userPersonalLists === "object") {
    for (const [uid, lists] of Object.entries(backup.userPersonalLists)) {
      if (!lists || typeof lists !== "object") continue;
      const region = normRegion(backup.users?.[uid]?.country) || defaultRegion;
      for (const doc of Object.values(lists)) {
        if (!Array.isArray(doc.items)) continue;
        for (let i = 0; i < doc.items.length; i++) {
          const m = doc.items[i];
          if (isBareRegistryRef(m)) continue;
          const id = numTmdbId(m);
          if (id == null) continue;
          const names = cache.get(`${id}|${region}`) ?? [];
          const prev =
            m.servicesByRegion && typeof m.servicesByRegion === "object" ? { ...m.servicesByRegion } : {};
          prev[region] = names;
          Object.assign(m, { servicesByRegion: prev, services: names });
          userRows++;
        }
      }
    }
  }

  backup.exportedAt = new Date().toISOString();
  const reportPath = join(rootDir, "backups", "sync-services-from-tmdb-report.txt");
  const lines = [
    `sync-services-from-tmdb`,
    `Generated: ${backup.exportedAt}`,
    `Backup: ${backupPath}`,
    `Default region: ${defaultRegion}, titleRegistry: ${registryRegion}`,
    ``,
    `Unique tmdbIds: ${uniqueIds.length}`,
    `Provider lookups (id × region): ${pairs.length}`,
    `TMDB errors: ${errors.length}`,
    `titleRegistry rows updated: ${registryRows}`,
    `User item rows updated: ${userRows}`,
    `Shared list item rows updated: ${sharedRows}`,
    ``,
    `Shared list items: services[] cleared; use servicesByRegion + viewer country in UI.`,
    ``,
  ];
  if (errors.length) {
    lines.push("Errors (first 30):");
    errors.slice(0, 30).forEach((x) => lines.push(`  tmdbId ${x.id} region ${x.region}: ${x.err}`));
  }

  writeFileSync(backupPath, JSON.stringify(backup, null, 2), "utf-8");
  writeFileSync(reportPath, lines.join("\n"), "utf-8");

  console.log(lines.join("\n"));
  console.log(`\nWrote ${backupPath}`);
  console.log(`Report: ${reportPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
