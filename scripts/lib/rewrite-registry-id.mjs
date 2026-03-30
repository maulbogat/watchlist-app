/**
 * When titleRegistry doc id changes (e.g. legacy-* → tt*), rewrite list rows + status arrays.
 * @param {import("firebase-admin/firestore").Firestore} db
 */
export async function rewriteRegistryIdEverywhere(db, oldId, newId) {
  if (!oldId || !newId || oldId === newId) return;

  function needsPatch(data) {
    const items = Array.isArray(data.items) ? data.items : [];
    if (items.some((m) => m?.registryId === oldId)) return true;
    for (const k of ["watched", "maybeLater", "archive"]) {
      const a = Array.isArray(data[k]) ? data[k] : [];
      if (a.includes(oldId)) return true;
    }
    return false;
  }

  async function patchDoc(ref, data) {
    if (!needsPatch(data)) return;
    const items = Array.isArray(data.items) ? data.items : [];
    const nextItems = items.map((m) => {
      if (m?.registryId === oldId) return { registryId: newId };
      return m;
    });
    const mapStatus = (arr) => {
      const a = Array.isArray(arr) ? arr : [];
      if (!a.includes(oldId)) return a;
      return [...new Set(a.map((k) => (k === oldId ? newId : k)))];
    };
    const patch = {
      items: nextItems,
      watched: mapStatus(data.watched),
      maybeLater: mapStatus(data.maybeLater),
    };
    if (Array.isArray(data.archive)) patch.archive = mapStatus(data.archive);
    await ref.set(patch, { merge: true });
  }

  const users = await db.collection("users").get();
  for (const d of users.docs) {
    await patchDoc(d.ref, d.data());
    const pl = await d.ref.collection("personalLists").get();
    for (const p of pl.docs) await patchDoc(p.ref, p.data());
  }
  const shared = await db.collection("sharedLists").get();
  for (const d of shared.docs) await patchDoc(d.ref, d.data());
}
