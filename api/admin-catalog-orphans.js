/**
 * Admin-only: titleRegistry rows not referenced on any list (orphan catalog titles).
 * GET — requires `Authorization: Bearer <Firebase ID token>` and an admin UID.
 *
 * Response: `{ ok, count, registryDocCount, referencedDistinctCount, orphans[], truncated, omitted }`
 * (`orphans` capped at **1500** rows; `omitted` = extra count when truncated).
 *
 * Env: `FIREBASE_SERVICE_ACCOUNT`
 */

const { getFirestore, FieldPath } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { getAdminApp } = require("../src/api-lib/execute-upcoming-sync");
const { ADMIN_UIDS } = require("../src/api-lib/admin-uids");
const { scanCatalogOrphanIds } = require("../src/api-lib/catalog-orphan-scan.cjs");

const MAX_ORPHANS_IN_RESPONSE = 1500;

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
 * @param {import("firebase-admin/firestore").Firestore} db
 * @param {string[]} ids
 */
async function fetchOrphanSummaries(db, ids) {
  /** @type {{ registryId: string; title: string; year: number | string | null }[]} */
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

  const db = getFirestore(getAdminApp());
  const { orphanIds, registryDocCount, referencedDistinctCount } = await scanCatalogOrphanIds(db);
  const count = orphanIds.length;
  const truncated = count > MAX_ORPHANS_IN_RESPONSE;
  const slice = truncated ? orphanIds.slice(0, MAX_ORPHANS_IN_RESPONSE) : orphanIds;
  const orphans = await fetchOrphanSummaries(db, slice);

  return json(200, {
    ok: true,
    count,
    registryDocCount,
    referencedDistinctCount,
    orphans,
    truncated,
    omitted: truncated ? count - MAX_ORPHANS_IN_RESPONSE : 0,
  });
};

const { wrapNetlifyHandler } = require("../src/api-lib/vercel-adapter");
module.exports = wrapNetlifyHandler(exports.handler);
