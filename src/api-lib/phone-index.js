/**
 * Firestore `phoneIndex/{digits}` — maps WhatsApp sender → user + default add target.
 * Document IDs are digits-only (no +) for consistent matching with Cloud API `from`.
 */

/**
 * @param {string} e164Phone
 * @returns {string}
 */
function phoneIndexDocId(e164Phone) {
  return String(e164Phone || "").replace(/\D/g, "");
}

/**
 * @param {import('firebase-admin/firestore').Firestore} db
 * @param {string} e164Phone
 * @returns {Promise<{ uid: string, defaultAddListId: string, defaultListType: 'personal' | 'shared' } | null>}
 */
async function getPhoneIndexEntry(db, e164Phone) {
  const id = phoneIndexDocId(e164Phone);
  if (!id) return null;
  const snap = await db.collection("phoneIndex").doc(id).get();
  if (!snap.exists) return null;
  const d = snap.data() || {};
  const uid = typeof d.uid === "string" ? d.uid.trim() : "";
  const defaultAddListId = typeof d.defaultAddListId === "string" ? d.defaultAddListId.trim() : "";
  const rawType = d.defaultListType;
  const defaultListType = rawType === "shared" ? "shared" : "personal";
  if (!uid || !defaultAddListId) return null;
  return { uid, defaultAddListId, defaultListType };
}

/**
 * @param {import('firebase-admin/firestore').Firestore} db
 * @param {string} e164Phone
 * @param {{ uid: string, defaultAddListId: string, defaultListType: 'personal' | 'shared' }} payload
 * @returns {Promise<void>}
 */
async function setPhoneIndexEntry(db, e164Phone, payload) {
  const id = phoneIndexDocId(e164Phone);
  if (!id) throw new Error("Invalid phone for phoneIndex");
  const defaultListType = payload.defaultListType === "shared" ? "shared" : "personal";
  await db.collection("phoneIndex").doc(id).set(
    {
      uid: payload.uid,
      defaultAddListId: payload.defaultAddListId,
      defaultListType,
      updatedAt: new Date().toISOString(),
    },
    { merge: true }
  );
}

/**
 * @param {import('firebase-admin/firestore').Firestore} db
 * @param {string} e164Phone
 * @returns {Promise<void>}
 */
async function deletePhoneIndexEntry(db, e164Phone) {
  const id = phoneIndexDocId(e164Phone);
  if (!id) return;
  await db.collection("phoneIndex").doc(id).delete();
}

module.exports = {
  phoneIndexDocId,
  getPhoneIndexEntry,
  setPhoneIndexEntry,
  deletePhoneIndexEntry,
};
