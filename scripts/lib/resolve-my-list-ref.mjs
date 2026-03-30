/**
 * Resolve `users/{uid}/personalLists/{listId}` for the list the app shows as **MY LIST**.
 *
 * Order: **`WATCHLIST_PERSONAL_LIST_ID`** → doc named like **“My list”** → **`defaultPersonalListId`**.
 *
 * @param {import("firebase-admin/firestore").Firestore} db
 * @param {string} uid
 * @returns {Promise<import("firebase-admin/firestore").DocumentReference>}
 */
export async function resolveMyListPersonalRef(db, uid) {
  const uref = db.collection("users").doc(uid);
  const explicit = (process.env.WATCHLIST_PERSONAL_LIST_ID || "").trim();
  if (explicit) {
    return uref.collection("personalLists").doc(explicit);
  }

  const uSnap = await uref.get();
  if (!uSnap.exists) throw new Error(`users/${uid} does not exist`);
  const udata = uSnap.data() || {};

  const plSnap = await uref.collection("personalLists").get();
  const normName = (s) =>
    String(s || "")
      .trim()
      .toLowerCase();
  const namedHit = plSnap.docs.find((d) => {
    const n = normName(d.data()?.name);
    return n === "my list" || n.includes("my list");
  });
  if (namedHit) return namedHit.ref;

  const defaultId =
    typeof udata.defaultPersonalListId === "string" ? udata.defaultPersonalListId.trim() : "";
  if (defaultId) return uref.collection("personalLists").doc(defaultId);

  throw new Error(
    "Could not resolve a personal list: add one named “My list”, set users.defaultPersonalListId, or set WATCHLIST_PERSONAL_LIST_ID."
  );
}
