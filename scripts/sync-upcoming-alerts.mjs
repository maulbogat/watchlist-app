#!/usr/bin/env node
/**
 * Write Firestore `upcomingAlerts` from `titleRegistry` (same logic as Netlify `check-upcoming`).
 *
 * Use this when:
 * - `curl …/check-upcoming` returns Netlify "Internal Error" (often timeout on large registries)
 * - Scheduled runs hit the ~30s scheduled-function limit
 *
 * Requires: TMDB_API_KEY + FIREBASE_SERVICE_ACCOUNT or serviceAccountKey.json (see scripts/lib/admin-init.mjs)
 *
 *   node scripts/sync-upcoming-alerts.mjs
 */
import "dotenv/config";
import { createRequire } from "node:module";
import { getDb } from "./lib/admin-init.mjs";

const require = createRequire(import.meta.url);
const { runFullRegistrySync } = require("../api/lib/sync-upcoming-alerts.js");

const apiKey = process.env.TMDB_API_KEY;
if (!apiKey || !String(apiKey).trim()) {
  console.error("Set TMDB_API_KEY in .env (or the environment).");
  process.exit(1);
}

const db = getDb();
console.log("Syncing titleRegistry → upcomingAlerts (TMDB rate-limited; can take many minutes)…");
const start = Date.now();
try {
  const result = await runFullRegistrySync(db, apiKey);
  console.log(JSON.stringify(result, null, 2));
  console.log(`Done in ${Math.round((Date.now() - start) / 1000)}s`);
} catch (e) {
  console.error(e);
  process.exit(1);
}
