/**
 * Admin-only external status (query: ?service=github | ?service=vercel | ?service=gcs).
 * Requires `Authorization: Bearer <Firebase ID token>` and an admin UID.
 *
 * github — latest GitHub Actions run for Firestore backup (`backup.yml`).
 *   Env: optional `GITHUB_TOKEN`, optional `GITHUB_REPO` (default `maulbogat/movie-trailer-site`).
 *
 * vercel — latest deployment for the project.
 *   Env: `VERCEL_API_TOKEN`, `VERCEL_PROJECT_ID` (503 if either missing).
 *
 * gcs — latest Firestore native export folder in `movie-trailer-site-backups` (top-level prefixes).
 *   Uses `FIREBASE_SERVICE_ACCOUNT` with `@google-cloud/storage`. Service account needs
 *   `storage.objects.list` on the bucket (e.g. Storage Object Viewer).
 *   Success: `{ ok: true, lastExportAt, folderName, status }` — `success` if newest export
 *   is within **48 hours**, else `warning`. Failure: `{ ok: false, error }`.
 */

const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { Storage } = require("@google-cloud/storage");
const { ADMIN_UIDS } = require("../src/api-lib/admin-uids");

const GCS_BACKUP_BUCKET = "movie-trailer-site-backups";

const APP_NAME = "watchlist-admin";
const WORKFLOW_FILE = "backup.yml";

function getAdminApp() {
  if (global.__watchlistAdminApp) return global.__watchlistAdminApp;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT not set");
  const key = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
  const app = initializeApp({ credential: cert(key), projectId: key.project_id }, APP_NAME);
  global.__watchlistAdminApp = app;
  return app;
}

function corsHeaders() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: corsHeaders(),
    body: JSON.stringify(body),
  };
}

/**
 * @param {import('@netlify/functions').HandlerEvent} event
 */
async function handleGithub() {
  const repo = (process.env.GITHUB_REPO || "maulbogat/movie-trailer-site").trim();
  const ghToken = (process.env.GITHUB_TOKEN || "").trim();
  const apiUrl = `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(
    WORKFLOW_FILE
  )}/runs?per_page=1`;

  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "movie-trailer-site-external-status",
  };
  if (ghToken) {
    headers.Authorization = `Bearer ${ghToken}`;
  }

  let res;
  try {
    res = await fetch(apiUrl, { headers });
  } catch (e) {
    return json(200, {
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
    return json(200, {
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
    return json(200, {
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

  return json(200, {
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

/**
 * @param {import('@netlify/functions').HandlerEvent} event
 */
async function handleVercel() {
  const token = (process.env.VERCEL_API_TOKEN || "").trim();
  const projectId = (process.env.VERCEL_PROJECT_ID || "").trim();
  if (!token || !projectId) {
    return json(503, {
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
    return json(200, {
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
    return json(200, {
      ok: true,
      lastDeployment: null,
      vercelError: "Invalid JSON from Vercel",
      vercelHttpStatus: res.status,
    });
  }

  if (!res.ok) {
    return json(200, {
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

  return json(200, {
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

/**
 * Parse export folder name (e.g. Firestore default `YYYY-MM-DDTHH:MM:SS_…`) to UTC ms, or null.
 * @param {string} folderName
 * @returns {number | null}
 */
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

/**
 * @param {import('@google-cloud/storage').Bucket} bucket
 * @param {string} folderName
 * @returns {Promise<number | null>}
 */
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

/**
 * @param {import('@google-cloud/storage').Bucket} bucket
 * @returns {Promise<string[]>}
 */
async function listTopLevelExportPrefixes(bucket) {
  const names = [];
  /** @type {Record<string, unknown>} */
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

/**
 * @param {number} lastExportMs
 * @returns {"success" | "warning"}
 */
function gcsExportHealthStatus(lastExportMs) {
  const ageMs = Date.now() - lastExportMs;
  return ageMs <= GCS_FRESH_WINDOW_MS ? "success" : "warning";
}

/**
 * @param {import('@google-cloud/storage').Bucket} bucket
 * @param {string} folderName
 * @returns {Promise<number | null>}
 */
async function prefixSortOrActivityMs(bucket, folderName) {
  const parsed = parseExportFolderToUtcMs(folderName);
  if (parsed != null) return parsed;
  return newestObjectMsUnderPrefix(bucket, folderName);
}

async function handleGcs() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw || !String(raw).trim()) {
    return json(503, {
      ok: false,
      error: "FIREBASE_SERVICE_ACCOUNT is not set; it is required to read GCS backup status.",
    });
  }

  let key;
  try {
    key = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
  } catch (e) {
    return json(503, {
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
    return json(200, {
      ok: false,
      error: e instanceof Error ? e.message : "Could not init Storage client",
    });
  }

  const bucket = storage.bucket(GCS_BACKUP_BUCKET);

  try {
    const prefixes = await listTopLevelExportPrefixes(bucket);
    if (prefixes.length === 0) {
      return json(200, {
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
      return json(200, {
        ok: false,
        error: "Could not determine the most recent export time",
      });
    }

    const lastExportAt = new Date(lastMs).toISOString();
    const status = gcsExportHealthStatus(lastMs);

    return json(200, {
      ok: true,
      lastExportAt,
      folderName,
      status,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "GCS list failed";
    return json(200, {
      ok: false,
      error: msg,
    });
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders() };
  }
  if (event.httpMethod !== "GET") {
    return json(405, { ok: false, error: "Method not allowed" });
  }

  const authHeader = (event.headers && (event.headers.authorization || event.headers.Authorization)) || "";
  const idToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!idToken) {
    return json(401, { ok: false, error: "Authorization required" });
  }

  let uid;
  try {
    const decoded = await getAuth(getAdminApp()).verifyIdToken(idToken);
    uid = decoded.uid;
  } catch {
    return json(401, { ok: false, error: "Invalid or expired token" });
  }
  if (!ADMIN_UIDS.has(uid)) {
    return json(403, { ok: false, error: "Forbidden" });
  }

  const q = event.queryStringParameters || {};
  const service = typeof q.service === "string" ? q.service.trim().toLowerCase() : "";

  if (service === "github") {
    return handleGithub();
  }
  if (service === "vercel") {
    return handleVercel();
  }
  if (service === "gcs") {
    return handleGcs();
  }

  return json(400, {
    ok: false,
    error: "Missing or invalid query: use ?service=github, ?service=vercel, or ?service=gcs",
  });
};

const { wrapNetlifyHandler } = require("../src/api-lib/vercel-adapter");
module.exports = wrapNetlifyHandler(exports.handler);
