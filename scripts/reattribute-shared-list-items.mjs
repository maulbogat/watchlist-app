/**
 * Set `addedByUid` + denormalized name/photo on specific `sharedLists/{listId}.items[]`
 * rows, matched by canonical title (via titleRegistry).
 *
 * Usage:
 *   node scripts/reattribute-shared-list-items.mjs --dry-run --listId <id> --addedByUid <firebaseAuthUid> --title "Will Trent" --title "Loot"
 *   node scripts/reattribute-shared-list-items.mjs --write --listId <id> --addedByUid <uid> --title "..."
 *
 * Requires: serviceAccountKey.json (or FIREBASE_SERVICE_ACCOUNT), same as other admin scripts.
 */
import { getAuth } from "firebase-admin/auth";
import { getDb } from "./lib/admin-init.mjs";
import { loadAllRegistryMap } from "./lib/registry-query.mjs";

const db = getDb();
const auth = getAuth();

function parseArgs(argv) {
  const dryRun = !argv.includes("--write");
  const listIdx = argv.indexOf("--listId");
  const uidIdx = argv.indexOf("--addedByUid");
  const listId = listIdx !== -1 && argv[listIdx + 1] ? String(argv[listIdx + 1]).trim() : "";
  const addedByUid = uidIdx !== -1 && argv[uidIdx + 1] ? String(argv[uidIdx + 1]).trim() : "";
  const titles = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--title" && argv[i + 1]) {
      titles.push(String(argv[i + 1]).trim());
      i++;
    }
  }
  return { dryRun, listId, addedByUid, titles };
}

function normTitle(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[.'’"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Small strings only; helps with typos like "glengary" vs "glengarry". */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + c);
    }
  }
  return dp[m][n];
}

/**
 * Resolve a human title string to registryId(s). Prefers exact normalized title match;
 * otherwise unique substring match; else unique best fuzzy (Levenshtein ≤ 4).
 * @param {Map<string, object>} regMap
 * @param {string} query
 * @returns {{ registryId: string, title: string } | null}
 */
function resolveRegistryId(regMap, query) {
  const q = normTitle(query);
  if (!q) return null;
  const exact = [];
  const partial = [];
  for (const m of regMap.values()) {
    const t = normTitle(m.title || "");
    if (!t) continue;
    if (t === q) exact.push(m);
    else if (t.includes(q) || q.includes(t)) partial.push(m);
  }
  if (exact.length === 1) return { registryId: exact[0].registryId, title: exact[0].title };
  if (exact.length > 1) {
    console.warn(`Ambiguous exact match for "${query}":`, exact.map((x) => `${x.registryId} "${x.title}"`));
    return null;
  }
  if (partial.length === 1) return { registryId: partial[0].registryId, title: partial[0].title };
  if (partial.length > 1) {
    console.warn(`Ambiguous partial match for "${query}":`, partial.map((x) => `${x.registryId} "${x.title}"`));
    return null;
  }

  const scored = [];
  for (const m of regMap.values()) {
    const t = normTitle(m.title || "");
    if (!t) continue;
    scored.push({ m, d: levenshtein(q, t) });
  }
  scored.sort((a, b) => a.d - b.d);
  const minD = scored[0]?.d;
  if (minD != null && minD <= 4) {
    const atMin = scored.filter((x) => x.d === minD);
    if (atMin.length === 1) {
      const m = atMin[0].m;
      console.warn(`Fuzzy match (${minD}) for "${query}" → "${m.title}" (${m.registryId})`);
      return { registryId: m.registryId, title: m.title };
    }
    console.warn(
      `Ambiguous fuzzy match for "${query}" (distance ${minD}):`,
      atMin.map((x) => `${x.m.registryId} "${x.m.title}"`)
    );
    return null;
  }

  console.warn(`No titleRegistry match for "${query}"`);
  return null;
}

async function profileForUid(uid) {
  const snap = await db.collection("users").doc(uid).get();
  let displayName = "";
  let photoURL = "";
  if (snap.exists) {
    const d = snap.data();
    if (typeof d.displayName === "string" && d.displayName.trim()) displayName = d.displayName.trim();
    if (typeof d.photoURL === "string" && d.photoURL.trim()) photoURL = d.photoURL.trim();
  }
  try {
    const u = await auth.getUser(uid);
    if (!displayName && u.displayName && String(u.displayName).trim()) displayName = String(u.displayName).trim();
    if (!photoURL && u.photoURL && String(u.photoURL).trim()) photoURL = String(u.photoURL).trim();
  } catch {
    /* missing auth user */
  }
  return { displayName, photoURL };
}

async function main() {
  const { dryRun, listId, addedByUid, titles } = parseArgs(process.argv.slice(2));
  if (!listId || !addedByUid || titles.length === 0) {
    console.error(
      "Usage: node scripts/reattribute-shared-list-items.mjs [--dry-run|--write] --listId <id> --addedByUid <firebaseAuthUid> --title \"Title One\" --title \"Title Two\" ..."
    );
    process.exit(1);
  }

  const regMap = await loadAllRegistryMap(db);
  const ref = db.collection("sharedLists").doc(listId);
  const listSnap = await ref.get();
  if (!listSnap.exists) {
    console.error(`sharedLists/${listId} not found`);
    process.exit(1);
  }

  const data = listSnap.data();
  const items = Array.isArray(data.items) ? [...data.items] : [];

  const wantedRegistryIds = new Map();
  for (const q of titles) {
    const hit = resolveRegistryId(regMap, q);
    if (hit) wantedRegistryIds.set(hit.registryId, { query: q, canonical: hit.title });
  }

  const { displayName, photoURL } = await profileForUid(addedByUid);
  console.log(
    `Target profile: displayName=${displayName || "(empty)"} photoURL=${photoURL ? "yes" : "no"}`
  );

  let changed = 0;
  const next = items.map((row) => {
    if (!row || typeof row !== "object") return row;
    const rid = typeof row.registryId === "string" ? row.registryId.trim() : "";
    if (!rid || !wantedRegistryIds.has(rid)) return row;
    const meta = wantedRegistryIds.get(rid);
    const updated = { ...row, addedByUid };
    if (displayName) updated.addedByDisplayName = displayName;
    else delete updated.addedByDisplayName;
    if (photoURL) updated.addedByPhotoUrl = photoURL;
    else delete updated.addedByPhotoUrl;
    changed++;
    console.log(
      dryRun
        ? `[dry-run] Would set ${rid} "${meta.canonical}" (matched from "${meta.query}")`
        : `Set ${rid} "${meta.canonical}" (matched from "${meta.query}")`
    );
    return dryRun ? row : updated;
  });

  if (!dryRun && changed > 0) {
    await ref.set({ items: next }, { merge: true });
  }
  console.log(`\nDone (${dryRun ? "dry-run" : "write"}). Rows updated: ${changed}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
