import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-analytics.js";
import {
  getAuth,
  signInWithPopup,
  GoogleAuthProvider,
  signOut as fbSignOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  collection,
  addDoc,
  query,
  where,
  getDocs,
  arrayUnion,
  arrayRemove,
} from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDKnQufhinuv-jKXNOyVM_mQDmRpdOD0VA",
  authDomain: "movie-trailer-site.firebaseapp.com",
  projectId: "movie-trailer-site",
  storageBucket: "movie-trailer-site.firebasestorage.app",
  messagingSenderId: "760692399711",
  appId: "1:760692399711:web:322f98f5fe127aa5f2c5ea",
  measurementId: "G-4799K3WXK4",
};

const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
const auth = getAuth(app);
const db = getFirestore(app);

function movieKey(m) {
  return `${m.title}|${m.year ?? ""}`;
}

async function getMoviesCatalog() {
  const ref = doc(db, "catalog", "movies");
  const snap = await getDoc(ref);
  if (!snap.exists() || !Array.isArray(snap.data().items)) return [];
  return snap.data().items;
}

/**
 * Returns status data from Firestore.
 * Data model: users/{uid} = { items: [], watched: [], maybeLater: [], archive: [], removed: [] }
 */
async function getStatusData(uid) {
  const ref = doc(db, "users", uid);
  const snap = await getDoc(ref);
  const data = snap.exists() ? snap.data() : {};
  return {
    items: Array.isArray(data.items) ? data.items : [],
    watched: Array.isArray(data.watched) ? data.watched : [],
    maybeLater: Array.isArray(data.maybeLater) ? data.maybeLater : [],
    archive: Array.isArray(data.archive) ? data.archive : [],
    removed: Array.isArray(data.removed) ? data.removed : [],
  };
}

/**
 * Returns the user's movie list with status applied. Each account has its own list.
 * Migrates legacy users (catalog + status) to per-user items on first load.
 */
async function getUserMovies(uid) {
  const data = await getStatusData(uid);
  let items = data.items;

  const hasLegacyData =
    data.watched?.length > 0 ||
    data.maybeLater?.length > 0 ||
    data.archive?.length > 0 ||
    data.removed?.length > 0;

  if (items.length === 0 && hasLegacyData) {
    const catalog = await getMoviesCatalog();
    if (catalog.length > 0) {
      const removedSet = new Set(data.removed);
      const watchedSet = new Set(data.watched);
      const maybeLaterSet = new Set(data.maybeLater);
      const archiveSet = new Set(data.archive);
      items = catalog
        .filter((m) => !removedSet.has(movieKey(m)))
        .map((m) => {
          const key = movieKey(m);
          let status = "to-watch";
          if (watchedSet.has(key)) status = "watched";
          else if (maybeLaterSet.has(key)) status = "maybe-later";
          else if (archiveSet.has(key)) status = "archive";
          return { ...m, status };
        });
      await setDoc(doc(db, "users", uid), { items }, { merge: true });
    }
  }

  if (items.length > 0) {
    const watchedSet = new Set(data.watched);
    const maybeLaterSet = new Set(data.maybeLater);
    const archiveSet = new Set(data.archive);
    const removedSet = new Set(data.removed);
    items = items.map((m) => {
      const key = movieKey(m);
      let status = "to-watch";
      if (watchedSet.has(key)) status = "watched";
      else if (maybeLaterSet.has(key)) status = "maybe-later";
      else if (archiveSet.has(key)) status = "archive";
      return { ...m, status, removed: removedSet.has(key) };
    });
  }

  return items;
}

/** @deprecated Use getStatusData. Kept for backward compat. */
async function getWatchedList(uid) {
  const { watched } = await getStatusData(uid);
  return watched;
}

async function setStatus(uid, key, status) {
  const ref = doc(db, "users", uid);
  const removeFromAll = {
    watched: arrayRemove(key),
    maybeLater: arrayRemove(key),
    archive: arrayRemove(key),
  };
  if (status === "to-watch") {
    await setDoc(ref, removeFromAll, { merge: true });
    return;
  }
  const addTo = status === "watched" ? "watched" : status === "maybe-later" ? "maybeLater" : "archive";
  await setDoc(ref, { ...removeFromAll, [addTo]: arrayUnion(key) }, { merge: true });
}

async function addWatched(uid, key) {
  await setStatus(uid, key, "watched");
}

async function removeWatched(uid, key) {
  await setStatus(uid, key, "to-watch");
}

async function removeTitle(uid, key) {
  const ref = doc(db, "users", uid);
  await setDoc(
    ref,
    {
      watched: arrayRemove(key),
      maybeLater: arrayRemove(key),
      archive: arrayRemove(key),
      removed: arrayUnion(key),
    },
    { merge: true }
  );
}

// --- Shared lists ---

function randomId() {
  return Math.random().toString(36).slice(2, 12);
}

async function createSharedList(uid, name) {
  const listId = randomId() + randomId();
  const ref = doc(db, "sharedLists", listId);
  await setDoc(ref, {
    name: name || "Shared list",
    ownerId: uid,
    members: [uid],
    items: [],
    watched: [],
    maybeLater: [],
    archive: [],
    removed: [],
    createdAt: new Date().toISOString(),
  });
  return listId;
}

async function getSharedList(listId) {
  const ref = doc(db, "sharedLists", listId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  return { id: listId, ...snap.data() };
}

async function getSharedListsForUser(uid) {
  const q = query(
    collection(db, "sharedLists"),
    where("members", "array-contains", uid)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function getSharedListMovies(listId) {
  const data = await getSharedList(listId);
  if (!data) return [];
  const items = Array.isArray(data.items) ? data.items : [];
  const watchedSet = new Set(data.watched || []);
  const maybeLaterSet = new Set(data.maybeLater || []);
  const archiveSet = new Set(data.archive || []);
  const removedSet = new Set(data.removed || []);
  return items.map((m) => {
    const key = movieKey(m);
    let status = "to-watch";
    if (watchedSet.has(key)) status = "watched";
    else if (maybeLaterSet.has(key)) status = "maybe-later";
    else if (archiveSet.has(key)) status = "archive";
    return { ...m, status, removed: removedSet.has(key) };
  });
}

async function setSharedListStatus(listId, key, status) {
  const ref = doc(db, "sharedLists", listId);
  const removeFromAll = {
    watched: arrayRemove(key),
    maybeLater: arrayRemove(key),
    archive: arrayRemove(key),
  };
  if (status === "to-watch") {
    await setDoc(ref, removeFromAll, { merge: true });
    return;
  }
  const addTo = status === "watched" ? "watched" : status === "maybe-later" ? "maybeLater" : "archive";
  await setDoc(ref, { ...removeFromAll, [addTo]: arrayUnion(key) }, { merge: true });
}

async function removeFromSharedList(listId, key) {
  const ref = doc(db, "sharedLists", listId);
  await setDoc(
    ref,
    {
      watched: arrayRemove(key),
      maybeLater: arrayRemove(key),
      archive: arrayRemove(key),
      removed: arrayUnion(key),
    },
    { merge: true }
  );
}

async function addToSharedList(listId, movie) {
  const ref = doc(db, "sharedLists", listId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error("Shared list not found");
  const data = snap.data();
  const items = Array.isArray(data.items) ? [...data.items] : [];
  const key = movieKey(movie);
  const exists = items.some((m) => movieKey(m) === key);
  if (exists) return;
  items.push(movie);
  await setDoc(ref, { items, removed: (data.removed || []).filter((k) => k !== key) }, { merge: true });
}

/**
 * Copy all items from user's personal list to a shared list. Preserves status (watched, maybe-later, archive).
 * Does NOT remove items from the personal list — both lists keep the items.
 */
async function moveAllToSharedList(uid, listId) {
  const listData = await getSharedList(listId);
  if (!listData) throw new Error("Shared list not found");
  const members = Array.isArray(listData.members) ? listData.members : [];
  if (!members.includes(uid)) throw new Error("You are not a member of this shared list");

  const userData = await getStatusData(uid);
  const userItems = Array.isArray(userData.items) ? userData.items : [];
  const userRemoved = new Set(userData.removed || []);
  const userWatched = new Set(userData.watched || []);
  const userMaybeLater = new Set(userData.maybeLater || []);
  const userArchive = new Set(userData.archive || []);

  const toCopy = userItems.filter((m) => !userRemoved.has(movieKey(m)));
  if (toCopy.length === 0) throw new Error("Your list is empty");

  const listRef = doc(db, "sharedLists", listId);
  const listSnap = await getDoc(listRef);
  const listDoc = listSnap.exists() ? listSnap.data() : {};
  const listItems = Array.isArray(listDoc.items) ? [...listDoc.items] : [];
  const listWatched = new Set(listDoc.watched || []);
  const listMaybeLater = new Set(listDoc.maybeLater || []);
  const listArchive = new Set(listDoc.archive || []);
  const listRemoved = new Set(listDoc.removed || []);

  const existingKeys = new Set(listItems.map((m) => movieKey(m)));

  for (const m of toCopy) {
    const key = movieKey(m);
    if (existingKeys.has(key)) continue;
    const { status, removed, ...movie } = m;
    listItems.push(movie);
    existingKeys.add(key);
    listRemoved.delete(key);
    if (userWatched.has(key)) listWatched.add(key);
    else if (userMaybeLater.has(key)) listMaybeLater.add(key);
    else if (userArchive.has(key)) listArchive.add(key);
  }

  await setDoc(
    listRef,
    {
      items: listItems,
      watched: [...listWatched],
      maybeLater: [...listMaybeLater],
      archive: [...listArchive],
      removed: [...listRemoved],
    },
    { merge: true }
  );
}

/**
 * Copy all items from a shared list back to the user's personal list. Use to recover after a move.
 * Preserves status (watched, maybe-later, archive). Does not remove items from the shared list.
 */
async function copySharedListToPersonal(uid, listId) {
  const listData = await getSharedList(listId);
  if (!listData) throw new Error("Shared list not found");
  const members = Array.isArray(listData.members) ? listData.members : [];
  if (!members.includes(uid)) throw new Error("You are not a member of this shared list");

  const listItems = Array.isArray(listData.items) ? listData.items : [];
  const listWatched = new Set(listData.watched || []);
  const listMaybeLater = new Set(listData.maybeLater || []);
  const listArchive = new Set(listData.archive || []);
  const listRemoved = new Set(listData.removed || []);

  const toCopy = listItems.filter((m) => !listRemoved.has(movieKey(m)));
  if (toCopy.length === 0) throw new Error("Shared list is empty");

  const userData = await getStatusData(uid);
  const userItems = Array.isArray(userData.items) ? [...userData.items] : [];
  const userWatched = new Set(userData.watched || []);
  const userMaybeLater = new Set(userData.maybeLater || []);
  const userArchive = new Set(userData.archive || []);
  const userRemoved = new Set(userData.removed || []);

  const existingKeys = new Set(userItems.map((m) => movieKey(m)));

  for (const m of toCopy) {
    const key = movieKey(m);
    if (existingKeys.has(key)) continue;
    const { status, removed, ...movie } = m;
    userItems.push(movie);
    existingKeys.add(key);
    userRemoved.delete(key);
    if (listWatched.has(key)) userWatched.add(key);
    else if (listMaybeLater.has(key)) userMaybeLater.add(key);
    else if (listArchive.has(key)) userArchive.add(key);
  }

  const userRef = doc(db, "users", uid);
  await setDoc(
    userRef,
    {
      items: userItems,
      watched: [...userWatched],
      maybeLater: [...userMaybeLater],
      archive: [...userArchive],
      removed: [...userRemoved],
    },
    { merge: true }
  );
}

/**
 * Move a single item from a shared list to the user's personal list.
 * Adds to personal if not there, restores from removed if hidden, removes from shared list.
 */
async function moveItemFromSharedToPersonal(uid, listId, movie) {
  const listData = await getSharedList(listId);
  if (!listData) throw new Error("Shared list not found");
  const members = Array.isArray(listData.members) ? listData.members : [];
  if (!members.includes(uid)) throw new Error("You are not a member of this shared list");

  const key = movieKey(movie);
  const userData = await getStatusData(uid);
  const userItems = Array.isArray(userData.items) ? [...userData.items] : [];
  const userRemoved = new Set(userData.removed || []);
  const userWatched = new Set(userData.watched || []);
  const userMaybeLater = new Set(userData.maybeLater || []);
  const userArchive = new Set(userData.archive || []);

  const existingKeys = new Set(userItems.map((m) => movieKey(m)));
  if (!existingKeys.has(key)) {
    const { status, removed, ...movieClean } = movie;
    userItems.push(movieClean);
    const s = status || "to-watch";
    if (s === "watched") userWatched.add(key);
    else if (s === "maybe-later") userMaybeLater.add(key);
    else if (s === "archive") userArchive.add(key);
  }
  userRemoved.delete(key);

  const userRef = doc(db, "users", uid);
  await setDoc(
    userRef,
    {
      items: userItems,
      watched: [...userWatched],
      maybeLater: [...userMaybeLater],
      archive: [...userArchive],
      removed: arrayRemove(key),
    },
    { merge: true }
  );

  await removeFromSharedList(listId, key);
}

/**
 * Update a movie's metadata (thumb, youtubeId) in the current list.
 */
async function updateMovieMetadata(uid, listMode, key, updates) {
  if (listMode === "personal") {
    const data = await getStatusData(uid);
    const items = Array.isArray(data.items) ? [...data.items] : [];
    const idx = items.findIndex((m) => movieKey(m) === key);
    if (idx < 0) return;
    if (updates.thumb) items[idx].thumb = updates.thumb;
    if (updates.youtubeId) items[idx].youtubeId = updates.youtubeId;
    await setDoc(doc(db, "users", uid), { items }, { merge: true });
  } else if (typeof listMode === "object" && listMode?.type === "shared") {
    const listId = listMode.listId;
    const listData = await getSharedList(listId);
    if (!listData) return;
    const members = listData.members || [];
    if (!members.includes(uid)) return;
    const items = Array.isArray(listData.items) ? [...listData.items] : [];
    const idx = items.findIndex((m) => movieKey(m) === key);
    if (idx < 0) return;
    if (updates.thumb) items[idx].thumb = updates.thumb;
    if (updates.youtubeId) items[idx].youtubeId = updates.youtubeId;
    await setDoc(doc(db, "sharedLists", listId), { items }, { merge: true });
  }
}

/**
 * Remove from user's personal list any item that exists in the shared list.
 * Keeps items only in the shared list.
 */
async function removeDuplicatesFromPersonal(uid, listId) {
  const listData = await getSharedList(listId);
  if (!listData) throw new Error("Shared list not found");
  const members = Array.isArray(listData.members) ? listData.members : [];
  if (!members.includes(uid)) throw new Error("You are not a member of this shared list");

  const listItems = Array.isArray(listData.items) ? listData.items : [];
  const listRemoved = new Set(listData.removed || []);
  const sharedKeys = new Set(listItems.filter((m) => !listRemoved.has(movieKey(m))).map((m) => movieKey(m)));

  const userData = await getStatusData(uid);
  const userItems = Array.isArray(userData.items) ? userData.items : [];
  const userRemoved = new Set(userData.removed || []);

  const toRemove = [];
  for (const m of userItems) {
    const key = movieKey(m);
    if (userRemoved.has(key)) continue;
    if (sharedKeys.has(key)) toRemove.push(key);
  }

  for (const key of toRemove) {
    await removeTitle(uid, key);
  }
  return toRemove.length;
}

export {
  auth,
  db,
  analytics,
  signInWithPopup,
  GoogleAuthProvider,
  fbSignOut,
  onAuthStateChanged,
  movieKey,
  getMoviesCatalog,
  getUserMovies,
  getWatchedList,
  getStatusData,
  setStatus,
  addWatched,
  removeWatched,
  removeTitle,
  createSharedList,
  getSharedList,
  getSharedListsForUser,
  getSharedListMovies,
  setSharedListStatus,
  removeFromSharedList,
  addToSharedList,
  moveAllToSharedList,
  copySharedListToPersonal,
  moveItemFromSharedToPersonal,
  updateMovieMetadata,
  removeDuplicatesFromPersonal,
};
