/**
 * Consolidated admin API (Vercel dynamic route: `/api/admin/:segment`).
 *
 * Segments:
 * - `external-status` — GET `?service=github|vercel|gcs|axiom|sentry` + Bearer + admin UID
 * - `job-config` — GET/POST `meta/jobConfig` (no Firebase user auth; same-origin / server only)
 * - `catalog-orphans` — GET + Bearer + admin UID
 * - `delete-registry-orphan` — POST `{ registryId }` + Bearer + admin UID
 * - `catalog-health` — POST `{ imdbId }` + Bearer + admin UID
 */

const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldPath } = require("firebase-admin/firestore");
const { Storage } = require("@google-cloud/storage");
const { getAdminApp } = require("../../src/api-lib/execute-upcoming-sync");
const { ADMIN_UIDS } = require("../../src/api-lib/admin-uids");
const { readJobConfig, setCheckUpcomingEnabled, setGithubBackupEnabled } = require("../../src/api-lib/job-config");
const { scanCatalogOrphanIds, scanReferencedRegistryIds } = require("../../src/api-lib/catalog-orphan-scan.cjs");

const GCS_BACKUP_BUCKET = "movie-trailer-site-backups";
const AXIOM_ACTIVITY_APL =
  "['watchlist-prod'] | where _time > ago(24h) | summarize firestore_reads = sumif(documentCount, tostring(type) == 'firestore.read'), api_calls = countif(tostring(type) == 'api.call'), user_actions = countif(tostring(type) == 'user.action'), errors = countif(tostring(type) == 'job.failed' or tostring(type) == 'whatsapp.imdb.error'), titles_added = countif(tostring(type) == 'title.added')";
const AXIOM_APL_QUERY_URL = "https://api.axiom.co/v1/datasets/_apl?format=tabular";
const WORKFLOW_FILE = "backup.yml";
const TMDB_IMG_BASE = "https://image.tmdb.org/t/p/w500";
const MAX_ORPHANS_IN_RESPONSE = 1500;
const MAX_REGISTRY_ID_LEN = 512;

function corsExternalStatus() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function corsJobConfig() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function corsCatalogOrphans() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function corsPostAuth() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(statusCode, headersFn, body) {
  return {
    statusCode,
    headers: headersFn(),
    body: JSON.stringify(body),
  };
}

/**
 * @param {import('@netlify/functions').HandlerEvent} event
 */
function getSegment(event) {
  const q = event.queryStringParameters || {};
  const fromQuery = q.segment != null ? String(q.segment).trim() : "";
  if (fromQuery) return fromQuery;
  const path = typeof event.path === "string" ? event.path : "";
  const m = path.match(/\/api\/admin\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

async function handleGithub() {
  const repo = (process.env.GITHUB_REPO || "maulbogat/watchlist").trim();
  const ghToken = (process.env.GITHUB_TOKEN || "").trim();
  const apiUrl = `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(
    WORKFLOW_FILE
  )}/runs?per_page=1`;

  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "watchlist-external-status",
  };
  if (ghToken) {
    headers.Authorization = `Bearer ${ghToken}`;
  }

  let res;
  try {
    res = await fetch(apiUrl, { headers });
  } catch (e) {
    return json(200, corsExternalStatus, {
      ok: true,
      repo,
      workflowFile: WORKFLOW_FILE,
      actionsUrl: `https://github.com/${repo}/actions/workflows/${WORKFLOW_FILE}`,
      lastRun: null,
      githubError: e instanceof Error ? e.message : "GitHub request failed",
    });
  }

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    return json(200, corsExternalStatus, {
      ok: true,
      repo,
      workflowFile: WORKFLOW_FILE,
      actionsUrl: `https://github.com/${repo}/actions/workflows/${WORKFLOW_FILE}`,
      lastRun: null,
      githubError: "Invalid JSON from GitHub",
      githubHttpStatus: res.status,
    });
  }

  if (!res.ok) {
    return json(200, corsExternalStatus, {
      ok: true,
      repo,
      workflowFile: WORKFLOW_FILE,
      actionsUrl: `https://github.com/${repo}/actions/workflows/${WORKFLOW_FILE}`,
      lastRun: null,
      githubError: data.message || `GitHub API ${res.status}`,
      githubHttpStatus: res.status,
    });
  }

  const run =
    Array.isArray(data.workflow_runs) && data.workflow_runs.length > 0 ? data.workflow_runs[0] : null;

  return json(200, corsExternalStatus, {
    ok: true,
    repo,
    workflowFile: WORKFLOW_FILE,
    workflowName: run?.name || "Daily Firestore Backup",
    actionsUrl: `https://github.com/${repo}/actions/workflows/${WORKFLOW_FILE}`,
    lastRun: run
      ? {
          status: run.status,
          conclusion: run.conclusion,
          created_at: run.created_at,
          updated_at: run.updated_at,
          html_url: run.html_url,
          event: run.event,
          run_attempt: run.run_attempt,
        }
      : null,
  });
}

async function handleVercel() {
  const token = (process.env.VERCEL_API_TOKEN || "").trim();
  const projectId = (process.env.VERCEL_PROJECT_ID || "").trim();
  if (!token || !projectId) {
    return json(503, corsExternalStatus, {
      ok: false,
      error:
        "Vercel deployment status is not configured. Set VERCEL_API_TOKEN and VERCEL_PROJECT_ID in the server environment.",
    });
  }

  const apiUrl = `https://api.vercel.com/v6/deployments?projectId=${encodeURIComponent(projectId)}&limit=1`;
  let res;
  try {
    res = await fetch(apiUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (e) {
    return json(200, corsExternalStatus, {
      ok: true,
      lastDeployment: null,
      vercelError: e instanceof Error ? e.message : "Vercel request failed",
    });
  }

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    return json(200, corsExternalStatus, {
      ok: true,
      lastDeployment: null,
      vercelError: "Invalid JSON from Vercel",
      vercelHttpStatus: res.status,
    });
  }

  if (!res.ok) {
    return json(200, corsExternalStatus, {
      ok: true,
      lastDeployment: null,
      vercelError: data.error?.message || data.message || `Vercel API ${res.status}`,
      vercelHttpStatus: res.status,
    });
  }

  const dep = Array.isArray(data.deployments) && data.deployments.length > 0 ? data.deployments[0] : null;
  const created = dep && (dep.createdAt != null ? dep.createdAt : dep.created);
  const meta = dep && dep.meta && typeof dep.meta === "object" ? dep.meta : {};
  const rawMsg = meta.githubCommitMessage;
  const githubCommitMessage = rawMsg != null && String(rawMsg).trim() !== "" ? String(rawMsg) : "";

  return json(200, corsExternalStatus, {
    ok: true,
    lastDeployment: dep
      ? {
          state: dep.state || "UNKNOWN",
          createdAt: created,
          url: dep.url || "",
          meta: { githubCommitMessage },
        }
      : null,
  });
}

function parseExportFolderToUtcMs(folderName) {
  if (!folderName || typeof folderName !== "string") return null;
  const trimmed = folderName.trim();
  const isoPrefix = trimmed.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
  if (isoPrefix) {
    const ms = Date.parse(`${isoPrefix[1]}Z`);
    if (!Number.isNaN(ms)) return ms;
  }
  const beforeUs = trimmed.split("_")[0];
  if (beforeUs && beforeUs !== trimmed) {
    const ms2 = Date.parse(beforeUs.endsWith("Z") ? beforeUs : `${beforeUs}Z`);
    if (!Number.isNaN(ms2)) return ms2;
  }
  const ms3 = Date.parse(trimmed);
  if (!Number.isNaN(ms3)) return ms3;
  return null;
}

async function newestObjectMsUnderPrefix(bucket, folderName) {
  const prefix = `${folderName}/`;
  const [files] = await bucket.getFiles({ prefix, maxResults: 1, autoPaginate: false });
  const f = files && files[0];
  if (!f) return null;
  const [meta] = await f.getMetadata();
  const raw = meta.updated || meta.timeCreated;
  if (!raw) return null;
  const ms = new Date(raw).getTime();
  return Number.isNaN(ms) ? null : ms;
}

async function listTopLevelExportPrefixes(bucket) {
  const names = [];
  let query = { autoPaginate: false, delimiter: "/" };
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const [, nextQuery, apiResponse] = await bucket.getFiles(query);
    const prefs = apiResponse && Array.isArray(apiResponse.prefixes) ? apiResponse.prefixes : [];
    for (const p of prefs) {
      const n = String(p).replace(/\/$/, "").trim();
      if (n) names.push(n);
    }
    if (!nextQuery || typeof nextQuery !== "object") break;
    query = nextQuery;
  }
  return names;
}

const GCS_FRESH_WINDOW_MS = 48 * 60 * 60 * 1000;

function gcsExportHealthStatus(lastExportMs) {
  const ageMs = Date.now() - lastExportMs;
  return ageMs <= GCS_FRESH_WINDOW_MS ? "success" : "warning";
}

async function prefixSortOrActivityMs(bucket, folderName) {
  const parsed = parseExportFolderToUtcMs(folderName);
  if (parsed != null) return parsed;
  return newestObjectMsUnderPrefix(bucket, folderName);
}

function axiomNumber(v) {
  if (v == null) return 0;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseAxiomTabularSummary(data) {
  if (!data || typeof data !== "object") return null;
  const tables = data.tables;
  if (!Array.isArray(tables) || tables.length === 0) {
    return { firestoreReads: 0, apiCalls: 0, userActions: 0, errors: 0, titlesAdded: 0 };
  }
  const t = tables[0];
  if (!t || typeof t !== "object") return null;
  const fields = t.fields;
  const columns = t.columns;
  if (!Array.isArray(fields) || !Array.isArray(columns) || columns.length === 0) {
    return { firestoreReads: 0, apiCalls: 0, userActions: 0, errors: 0, titlesAdded: 0 };
  }
  const by = {};
  for (let i = 0; i < fields.length; i += 1) {
    const f = fields[i];
    const name = f && typeof f === "object" && "name" in f ? String(f.name) : "";
    const col = columns[i];
    const cell = Array.isArray(col) ? col[0] : undefined;
    if (name) by[name] = axiomNumber(cell);
  }
  return {
    firestoreReads: axiomNumber(by.firestore_reads),
    apiCalls: axiomNumber(by.api_calls),
    userActions: axiomNumber(by.user_actions),
    errors: axiomNumber(by.errors),
    titlesAdded: axiomNumber(by.titles_added),
  };
}

async function handleAxiom() {
  const token = (process.env.AXIOM_TOKEN || "").trim();
  if (!token) {
    return json(503, corsExternalStatus, {
      ok: false,
      error: "Axiom activity requires AXIOM_TOKEN in the server environment.",
    });
  }

  let res;
  try {
    res = await fetch(AXIOM_APL_QUERY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        apl: AXIOM_ACTIVITY_APL,
      }),
    });
  } catch (e) {
    return json(200, corsExternalStatus, {
      ok: false,
      error: e instanceof Error ? e.message : "Axiom request failed",
    });
  }

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    return json(200, corsExternalStatus, {
      ok: false,
      error: "Invalid JSON from Axiom",
      axiomHttpStatus: res.status,
    });
  }

  if (!res.ok) {
    const msg =
      (data && typeof data === "object" && data.message && String(data.message)) ||
      (data && typeof data === "object" && data.error && String(data.error)) ||
      `Axiom API ${res.status}`;
    return json(200, corsExternalStatus, {
      ok: false,
      error: msg,
      axiomHttpStatus: res.status,
    });
  }

  const parsed = parseAxiomTabularSummary(data);
  if (!parsed) {
    return json(200, corsExternalStatus, {
      ok: false,
      error: "Could not parse Axiom tabular result",
    });
  }

  return json(200, corsExternalStatus, {
    ok: true,
    firestoreReads: parsed.firestoreReads,
    apiCalls: parsed.apiCalls,
    userActions: parsed.userActions,
    errors: parsed.errors,
    titlesAdded: parsed.titlesAdded,
    period: "24h",
  });
}

async function handleSentry() {
  const token = (process.env.SENTRY_READ_TOKEN || "").trim();
  if (!token) {
    return json(503, corsExternalStatus, {
      ok: false,
      error: "Sentry issues summary requires SENTRY_READ_TOKEN in the server environment.",
    });
  }

  const project = (process.env.SENTRY_PROJECT || "").trim();
  if (!project) {
    return json(200, corsExternalStatus, {
      ok: false,
      error: "SENTRY_PROJECT is not set; it is required for the Sentry issues API path.",
    });
  }

  const qs = new URLSearchParams({
    query: "is:unresolved",
    statsPeriod: "24h",
    limit: "100",
  });
  const url = `https://sentry.io/api/0/projects/maulbogat/${encodeURIComponent(project)}/issues/?${qs.toString()}`;

  let res;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (e) {
    return json(200, corsExternalStatus, {
      ok: false,
      error: e instanceof Error ? e.message : "Sentry request failed",
    });
  }

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : [];
  } catch {
    return json(200, corsExternalStatus, {
      ok: false,
      error: "Invalid JSON from Sentry",
      sentryHttpStatus: res.status,
    });
  }

  if (!res.ok) {
    const msg =
      (data && typeof data === "object" && data.detail && String(data.detail)) ||
      (data && typeof data === "object" && data.message && String(data.message)) ||
      `Sentry API ${res.status}`;
    return json(200, corsExternalStatus, {
      ok: false,
      error: msg,
      sentryHttpStatus: res.status,
    });
  }

  const list = Array.isArray(data) ? data : null;
  if (!list) {
    return json(200, corsExternalStatus, {
      ok: false,
      error: "Unexpected Sentry response (expected a JSON array of issues)",
    });
  }

  return json(200, corsExternalStatus, {
    ok: true,
    errorCount: list.length,
    period: "24h",
  });
}

async function handleGcs() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw || !String(raw).trim()) {
    return json(503, corsExternalStatus, {
      ok: false,
      error: "FIREBASE_SERVICE_ACCOUNT is not set; it is required to read GCS backup status.",
    });
  }

  let key;
  try {
    key = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
  } catch (e) {
    return json(503, corsExternalStatus, {
      ok: false,
      error: e instanceof Error ? e.message : "Invalid FIREBASE_SERVICE_ACCOUNT JSON",
    });
  }

  const projectId = key.project_id || "movie-trailer-site";

  let storage;
  try {
    storage = new Storage({
      projectId,
      credentials: key,
    });
  } catch (e) {
    return json(200, corsExternalStatus, {
      ok: false,
      error: e instanceof Error ? e.message : "Could not init Storage client",
    });
  }

  const bucket = storage.bucket(GCS_BACKUP_BUCKET);

  try {
    const prefixes = await listTopLevelExportPrefixes(bucket);
    if (prefixes.length === 0) {
      return json(200, corsExternalStatus, {
        ok: false,
        error: "No export folders found in bucket",
      });
    }

    const withKeys = await Promise.all(
      prefixes.map(async (folderName) => ({
        folderName,
        sortMs: await prefixSortOrActivityMs(bucket, folderName),
      }))
    );

    withKeys.sort((a, b) => {
      const ma = a.sortMs;
      const mb = b.sortMs;
      if (ma != null && mb != null && ma !== mb) return mb - ma;
      if (ma != null && mb == null) return -1;
      if (ma == null && mb != null) return 1;
      return b.folderName.localeCompare(a.folderName);
    });

    const folderName = withKeys[0].folderName;
    let lastMs = parseExportFolderToUtcMs(folderName);
    if (lastMs == null) {
      lastMs = withKeys[0].sortMs;
    }
    if (lastMs == null || !Number.isFinite(lastMs)) {
      return json(200, corsExternalStatus, {
        ok: false,
        error: "Could not determine the most recent export time",
      });
    }

    const lastExportAt = new Date(lastMs).toISOString();
    const status = gcsExportHealthStatus(lastMs);

    return json(200, corsExternalStatus, {
      ok: true,
      lastExportAt,
      folderName,
      status,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "GCS list failed";
    return json(200, corsExternalStatus, {
      ok: false,
      error: msg,
    });
  }
}

async function handleExternalStatus(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsExternalStatus() };
  }
  if (event.httpMethod !== "GET") {
    return json(405, corsExternalStatus, { ok: false, error: "Method not allowed" });
  }

  const authHeader = (event.headers && (event.headers.authorization || event.headers.Authorization)) || "";
  const idToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!idToken) {
    return json(401, corsExternalStatus, { ok: false, error: "Authorization required" });
  }

  let uid;
  try {
    const decoded = await getAuth(getAdminApp()).verifyIdToken(idToken);
    uid = decoded.uid;
  } catch {
    return json(401, corsExternalStatus, { ok: false, error: "Invalid or expired token" });
  }
  if (!ADMIN_UIDS.has(uid)) {
    return json(403, corsExternalStatus, { ok: false, error: "Forbidden" });
  }

  const q = event.queryStringParameters || {};
  const service = typeof q.service === "string" ? q.service.trim().toLowerCase() : "";

  if (service === "github") return handleGithub();
  if (service === "vercel") return handleVercel();
  if (service === "gcs") return handleGcs();
  if (service === "axiom") return handleAxiom();
  if (service === "sentry") return handleSentry();

  return json(400, corsExternalStatus, {
    ok: false,
    error:
      "Missing or invalid query: use ?service=github, ?service=vercel, ?service=gcs, ?service=axiom, or ?service=sentry",
  });
}

function toIsoOrNull(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && value !== null && typeof value.toDate === "function") {
    const d = value.toDate();
    return d instanceof Date ? d.toISOString() : null;
  }
  if (typeof value === "string") return value;
  return null;
}

function normalizeJobConfig(raw) {
  return {
    checkUpcomingEnabled: raw.checkUpcomingEnabled !== false,
    githubBackupEnabled: raw.githubBackupEnabled !== false,
    lastRunAt: toIsoOrNull(raw.lastRunAt),
    lastRunStatus: raw.lastRunStatus || null,
    lastRunMessage: raw.lastRunMessage || null,
    lastRunResult: raw.lastRunResult || null,
  };
}

async function handleJobConfig(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsJobConfig() };
  }

  const db = getFirestore(getAdminApp());
  try {
    if (event.httpMethod === "GET") {
      const cfg = await readJobConfig(db);
      return {
        statusCode: 200,
        headers: corsJobConfig(),
        body: JSON.stringify({ ok: true, config: normalizeJobConfig(cfg) }),
      };
    }

    if (event.httpMethod === "POST") {
      const body = event.body ? JSON.parse(event.body) : {};
      const hasUpcoming = typeof body?.checkUpcomingEnabled === "boolean";
      const hasGithub = typeof body?.githubBackupEnabled === "boolean";
      if (!hasUpcoming && !hasGithub) {
        return {
          statusCode: 400,
          headers: corsJobConfig(),
          body: JSON.stringify({
            ok: false,
            error: "Body must include checkUpcomingEnabled and/or githubBackupEnabled as booleans",
          }),
        };
      }
      if (hasUpcoming) await setCheckUpcomingEnabled(db, body.checkUpcomingEnabled);
      if (hasGithub) await setGithubBackupEnabled(db, body.githubBackupEnabled);
      const cfg = await readJobConfig(db);
      return {
        statusCode: 200,
        headers: corsJobConfig(),
        body: JSON.stringify({ ok: true, config: normalizeJobConfig(cfg) }),
      };
    }

    return {
      statusCode: 405,
      headers: corsJobConfig(),
      body: JSON.stringify({ ok: false, error: "Use GET or POST" }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: corsJobConfig(),
      body: JSON.stringify({ ok: false, error: e?.message || String(e) }),
    };
  }
}

async function fetchOrphanSummaries(db, ids) {
  const rows = [];
  const chunkSize = 30;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    if (chunk.length === 0) continue;
    const snap = await db
      .collection("titleRegistry")
      .where(FieldPath.documentId(), "in", chunk)
      .select("title", "year")
      .get();
    const seen = new Set();
    for (const d of snap.docs) {
      seen.add(d.id);
      const x = d.data() || {};
      const title =
        typeof x.title === "string" && x.title.trim() !== "" ? x.title.trim() : d.id;
      const year = x.year != null && x.year !== "" ? x.year : null;
      rows.push({ registryId: d.id, title, year });
    }
    for (const id of chunk) {
      if (!seen.has(id)) rows.push({ registryId: id, title: id, year: null });
    }
  }
  rows.sort((a, b) => a.registryId.localeCompare(b.registryId));
  return rows;
}

async function handleCatalogOrphans(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsCatalogOrphans() };
  }
  if (event.httpMethod !== "GET") {
    return json(405, corsCatalogOrphans, { ok: false, error: "Method not allowed" });
  }

  const authHeader = (event.headers && (event.headers.authorization || event.headers.Authorization)) || "";
  const idToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!idToken) {
    return json(401, corsCatalogOrphans, { ok: false, error: "Authorization required" });
  }

  let uid;
  try {
    const decoded = await getAuth(getAdminApp()).verifyIdToken(idToken);
    uid = decoded.uid;
  } catch {
    return json(401, corsCatalogOrphans, { ok: false, error: "Invalid or expired token" });
  }
  if (!ADMIN_UIDS.has(uid)) {
    return json(403, corsCatalogOrphans, { ok: false, error: "Forbidden" });
  }

  const db = getFirestore(getAdminApp());
  const { orphanIds, registryDocCount, referencedDistinctCount } = await scanCatalogOrphanIds(db);
  const count = orphanIds.length;
  const truncated = count > MAX_ORPHANS_IN_RESPONSE;
  const slice = truncated ? orphanIds.slice(0, MAX_ORPHANS_IN_RESPONSE) : orphanIds;
  const orphans = await fetchOrphanSummaries(db, slice);

  return json(200, corsCatalogOrphans, {
    ok: true,
    count,
    registryDocCount,
    referencedDistinctCount,
    orphans,
    truncated,
    omitted: truncated ? count - MAX_ORPHANS_IN_RESPONSE : 0,
  });
}

function normalizeRegistryId(raw) {
  if (raw == null) return "";
  const s = String(raw).trim();
  if (!s || s.length > MAX_REGISTRY_ID_LEN) return "";
  if (s.includes("/") || s.includes("..")) return "";
  return s;
}

async function handleDeleteRegistryOrphan(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsPostAuth() };
  }
  if (event.httpMethod !== "POST") {
    return json(405, corsPostAuth, { ok: false, error: "Method not allowed" });
  }

  const authHeader = (event.headers && (event.headers.authorization || event.headers.Authorization)) || "";
  const idToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!idToken) {
    return json(401, corsPostAuth, { ok: false, error: "Authorization required" });
  }

  let uid;
  try {
    const decoded = await getAuth(getAdminApp()).verifyIdToken(idToken);
    uid = decoded.uid;
  } catch {
    return json(401, corsPostAuth, { ok: false, error: "Invalid or expired token" });
  }
  if (!ADMIN_UIDS.has(uid)) {
    return json(403, corsPostAuth, { ok: false, error: "Forbidden" });
  }

  let body;
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, corsPostAuth, { ok: false, error: "Invalid JSON body" });
  }

  const registryId = normalizeRegistryId(body.registryId);
  if (!registryId) {
    return json(400, corsPostAuth, { ok: false, error: "Missing or invalid registryId" });
  }

  const db = getFirestore(getAdminApp());
  const referenced = await scanReferencedRegistryIds(db);
  if (referenced.has(registryId)) {
    return json(409, corsPostAuth, {
      ok: false,
      error: "Title is on a list; remove it from lists before deleting from the catalog",
    });
  }

  const ref = db.collection("titleRegistry").doc(registryId);
  const snap = await ref.get();
  if (!snap.exists) {
    return json(404, corsPostAuth, { ok: false, error: "titleRegistry document not found" });
  }

  await ref.delete();
  return json(200, corsPostAuth, { ok: true, registryId });
}

function resolveTmdbMedia(data) {
  const m = data && data.tmdbMedia;
  if (m === "movie" || m === "tv") return m;
  const t = data && data.type;
  if (t === "movie") return "movie";
  if (t === "show") return "tv";
  return null;
}

function normalizeImdbId(raw) {
  if (raw == null) return "";
  const s = String(raw).trim();
  if (!s) return "";
  return s.startsWith("tt") ? s : `tt${s.replace(/^tt/i, "")}`;
}

async function handleCatalogHealth(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsPostAuth() };
  }
  if (event.httpMethod !== "POST") {
    return json(405, corsPostAuth, { ok: false, error: "Method not allowed" });
  }

  const authHeader = (event.headers && (event.headers.authorization || event.headers.Authorization)) || "";
  const idToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!idToken) {
    return json(401, corsPostAuth, { ok: false, error: "Authorization required" });
  }

  let uid;
  try {
    const decoded = await getAuth(getAdminApp()).verifyIdToken(idToken);
    uid = decoded.uid;
  } catch {
    return json(401, corsPostAuth, { ok: false, error: "Invalid or expired token" });
  }
  if (!ADMIN_UIDS.has(uid)) {
    return json(403, corsPostAuth, { ok: false, error: "Forbidden" });
  }

  let body;
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, corsPostAuth, { ok: false, error: "Invalid JSON body" });
  }

  const imdbId = normalizeImdbId(body.imdbId);
  if (!imdbId || !/^tt\d+$/i.test(imdbId)) {
    return json(400, corsPostAuth, { ok: false, error: "Missing or invalid imdbId" });
  }

  const apiKey = (process.env.TMDB_API_KEY || "").trim();
  if (!apiKey) {
    return json(503, corsPostAuth, { ok: false, error: "TMDB_API_KEY not configured" });
  }

  const db = getFirestore(getAdminApp());
  const ref = db.collection("titleRegistry").doc(imdbId);
  const snap = await ref.get();
  if (!snap.exists) {
    return json(404, corsPostAuth, { ok: false, error: "titleRegistry document not found" });
  }

  const data = snap.data() || {};
  const thumb = data.thumb;
  if (thumb != null && String(thumb).trim() !== "") {
    return json(200, corsPostAuth, { ok: true, thumb: String(thumb).trim(), alreadySet: true });
  }

  const tmdbId = data.tmdbId;
  if (tmdbId == null) {
    return json(400, corsPostAuth, { ok: false, error: "Document has no tmdbId" });
  }

  const media = resolveTmdbMedia(data);
  if (media == null) {
    return json(400, corsPostAuth, { ok: false, error: "Cannot derive TMDB media type from document" });
  }

  const url = `https://api.themoviedb.org/3/${media}/${encodeURIComponent(String(tmdbId))}?api_key=${encodeURIComponent(apiKey)}`;
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    return json(502, corsPostAuth, { ok: false, error: e instanceof Error ? e.message : "TMDB request failed" });
  }

  let details;
  try {
    details = await res.json();
  } catch {
    return json(502, corsPostAuth, { ok: false, error: "Invalid JSON from TMDB" });
  }

  if (!res.ok) {
    const msg = details?.status_message || `TMDB HTTP ${res.status}`;
    return json(502, corsPostAuth, { ok: false, error: msg });
  }

  const posterPath = details?.poster_path;
  if (!posterPath || typeof posterPath !== "string") {
    return json(404, corsPostAuth, { ok: false, error: "No poster_path from TMDB" });
  }

  const thumbUrl = `${TMDB_IMG_BASE}${posterPath}`;
  await ref.set({ thumb: thumbUrl }, { merge: true });

  return json(200, corsPostAuth, { ok: true, thumb: thumbUrl });
}

exports.handler = async (event) => {
  const segment = getSegment(event);
  const allowed = new Set([
    "external-status",
    "job-config",
    "catalog-orphans",
    "delete-registry-orphan",
    "catalog-health",
  ]);
  if (!segment || !allowed.has(segment)) {
    return json(404, corsExternalStatus, { ok: false, error: "Not found" });
  }

  try {
    if (segment === "external-status") return await handleExternalStatus(event);
    if (segment === "job-config") return await handleJobConfig(event);
    if (segment === "catalog-orphans") return await handleCatalogOrphans(event);
    if (segment === "delete-registry-orphan") return await handleDeleteRegistryOrphan(event);
    if (segment === "catalog-health") return await handleCatalogHealth(event);
  } catch (e) {
    return json(500, corsExternalStatus, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }

  return json(404, corsExternalStatus, { ok: false, error: "Not found" });
};

const { wrapNetlifyHandler } = require("../../src/api-lib/vercel-adapter");
module.exports = wrapNetlifyHandler(exports.handler);
