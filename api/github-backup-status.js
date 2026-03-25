/**
 * Admin-only: latest GitHub Actions run for the Firestore backup workflow (`backup.yml`).
 * Requires `Authorization: Bearer <Firebase ID token>` and an admin UID.
 *
 * Env (optional): `GITHUB_TOKEN` — fine-grained or classic PAT with `actions: read` if the
 * repo is private or to avoid rate limits. `GITHUB_REPO` — default `maulbogat/movie-trailer-site`.
 */

const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { ADMIN_UIDS } = require("./lib/admin-uids");

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

  const repo = (process.env.GITHUB_REPO || "maulbogat/movie-trailer-site").trim();
  const ghToken = (process.env.GITHUB_TOKEN || "").trim();
  const apiUrl = `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(
    WORKFLOW_FILE
  )}/runs?per_page=1`;

  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "movie-trailer-site-github-backup-status",
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
};

const { wrapNetlifyHandler } = require("./lib/vercel-adapter");
module.exports = wrapNetlifyHandler(exports.handler);
