/**
 * Catalog orphan scan: titleRegistry docs whose id is never referenced as `registryId`
 * on any sharedLists or `users/{uid}/personalLists` list doc (plus legacy `users.items`).
 *
 * Used by `api/admin-catalog-orphans.js`, `api/admin-delete-registry-orphan.js`, and `scripts/catalog-not-on-any-list.mjs`.
 *
 * @param {import("firebase-admin/firestore").Firestore} db
 * @returns {Promise<{ orphanIds: string[]; allRegistryIds: string[]; referencedIds: string[]; registryDocCount: number; referencedDistinctCount: number }>}
 */
function collectRegistryIdsFromItems(items) {
  const ids = new Set();
  if (!Array.isArray(items)) return ids;
  for (const row of items) {
    if (row && typeof row === "object" && row.registryId != null && String(row.registryId).trim()) {
      ids.add(String(row.registryId).trim());
    }
  }
  return ids;
}

async function scanReferencedRegistryIds(db) {
  const referenced = new Set();
  const slSnap = await db.collection("sharedLists").get();
  for (const d of slSnap.docs) {
    for (const id of collectRegistryIdsFromItems(d.data().items)) referenced.add(id);
  }
  const usersSnap = await db.collection("users").get();
  for (const u of usersSnap.docs) {
    const plSnap = await u.ref.collection("personalLists").get();
    for (const d of plSnap.docs) {
      for (const id of collectRegistryIdsFromItems(d.data().items)) referenced.add(id);
    }
    const ud = u.data();
    if (Array.isArray(ud.items)) {
      for (const id of collectRegistryIdsFromItems(ud.items)) referenced.add(id);
    }
  }
  return referenced;
}

async function scanCatalogOrphanIds(db) {
  const referenced = await scanReferencedRegistryIds(db);
  const trSnap = await db.collection("titleRegistry").select().get();
  const allIds = trSnap.docs.map((d) => d.id);
  const orphanIds = allIds.filter((id) => !referenced.has(id));
  orphanIds.sort();
  return {
    orphanIds,
    allRegistryIds: allIds,
    referencedIds: [...referenced].sort(),
    registryDocCount: allIds.length,
    referencedDistinctCount: referenced.size,
  };
}

module.exports = {
  collectRegistryIdsFromItems,
  scanReferencedRegistryIds,
  scanCatalogOrphanIds,
};
