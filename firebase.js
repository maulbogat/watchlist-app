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
  deleteDoc,
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
 * Fill missing imdbId on list rows from catalog (source of truth), by title|year.
 */
async function mergeImdbIdsFromCatalog(items) {
  if (!Array.isArray(items) || items.length === 0) return items;
  if (!items.some((m) => m && !m.imdbId)) return items;
  const catalog = await getMoviesCatalog();
  const exact = new Map();
  const loose = new Map();
  for (const c of catalog) {
    if (!c?.imdbId) continue;
    const id = String(c.imdbId).startsWith("tt") ? c.imdbId : `tt${c.imdbId}`;
    exact.set(movieKey(c), id);
    const t = String(c.title || "")
      .trim()
      .toLowerCase();
    const y = c.year == null || c.year === "" ? "" : String(c.year);
    loose.set(`${t}|${y}`, id);
  }
  return items.map((m) => {
    if (!m || m.imdbId) return m;
    let id = exact.get(movieKey(m));
    if (!id) {
      const t = String(m.title || "")
        .trim()
        .toLowerCase();
      const y = m.year == null || m.year === "" ? "" : String(m.year);
      id = loose.get(`${t}|${y}`);
    }
    return id ? { ...m, imdbId: id } : m;
  });
}

/**
 * Returns status data from Firestore.
 * Data model: users/{uid} = { items: [], watched: [], maybeLater: [], archive: [] }
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
    listName: data.listName || "My list",
    country: data.country || null,
    countryName: data.countryName || null,
  };
}

async function getUserProfile(uid) {
  const ref = doc(db, "users", uid);
  const snap = await getDoc(ref);
  const data = snap.exists() ? snap.data() : {};
  return {
    country: data.country || null,
    countryName: data.countryName || null,
  };
}

async function setUserCountry(uid, countryCode, countryName) {
  const ref = doc(db, "users", uid);
  await setDoc(ref, { country: countryCode, countryName: countryName || countryCode }, { merge: true });
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
    data.archive?.length > 0;

  if (items.length === 0 && hasLegacyData) {
    const catalog = await getMoviesCatalog();
    if (catalog.length > 0) {
      const watchedSet = new Set(data.watched);
      const maybeLaterSet = new Set(data.maybeLater);
      const archiveSet = new Set(data.archive);
      items = catalog.map((m) => {
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
    items = items.map((m) => {
      const key = movieKey(m);
      let status = "to-watch";
      if (watchedSet.has(key)) status = "watched";
      else if (maybeLaterSet.has(key)) status = "maybe-later";
      else if (archiveSet.has(key)) status = "archive";
      return { ...m, status };
    });
  }

  return mergeImdbIdsFromCatalog(items);
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
  const snap = await getDoc(ref);
  const data = snap.exists() ? snap.data() : {};
  const items = Array.isArray(data.items) ? data.items.filter((m) => movieKey(m) !== key) : [];
  await setDoc(
    ref,
    {
      items,
      watched: arrayRemove(key),
      maybeLater: arrayRemove(key),
      archive: arrayRemove(key),
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
  return mergeImdbIdsFromCatalog(
    items.map((m) => {
      const key = movieKey(m);
      let status = "to-watch";
      if (watchedSet.has(key)) status = "watched";
      else if (maybeLaterSet.has(key)) status = "maybe-later";
      else if (archiveSet.has(key)) status = "archive";
      return { ...m, status };
    })
  );
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
  const snap = await getDoc(ref);
  const data = snap.exists() ? snap.data() : {};
  const items = Array.isArray(data.items) ? data.items.filter((m) => movieKey(m) !== key) : [];
  await setDoc(
    ref,
    {
      items,
      watched: arrayRemove(key),
      maybeLater: arrayRemove(key),
      archive: arrayRemove(key),
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
  const { status, ...movieClean } = movie;
  items.push(movieClean);
  const watched = new Set(data.watched || []);
  const maybeLater = new Set(data.maybeLater || []);
  const archive = new Set(data.archive || []);
  const s = status || "to-watch";
  if (s === "watched") watched.add(key);
  else if (s === "maybe-later") maybeLater.add(key);
  else if (s === "archive") archive.add(key);
  await setDoc(ref, { items, watched: [...watched], maybeLater: [...maybeLater], archive: [...archive] }, { merge: true });
}

async function addToPersonalList(uid, listId, movie) {
  const key = movieKey(movie);
  const { status, ...movieClean } = movie;
  const s = status || "to-watch";
  if (listId === "personal") {
    const ref = doc(db, "users", uid);
    const snap = await getDoc(ref);
    const data = snap.exists() ? snap.data() : {};
    const items = Array.isArray(data.items) ? [...data.items] : [];
    if (items.some((m) => movieKey(m) === key)) return;
    items.push(movieClean);
    const watched = new Set(data.watched || []);
    const maybeLater = new Set(data.maybeLater || []);
    const archive = new Set(data.archive || []);
    if (s === "watched") watched.add(key);
    else if (s === "maybe-later") maybeLater.add(key);
    else if (s === "archive") archive.add(key);
    await setDoc(ref, { items, watched: [...watched], maybeLater: [...maybeLater], archive: [...archive] }, { merge: true });
  } else {
    const ref = doc(db, "users", uid, "personalLists", listId);
    const snap = await getDoc(ref);
    if (!snap.exists()) throw new Error("Personal list not found");
    const data = snap.data();
    const items = Array.isArray(data.items) ? [...data.items] : [];
    if (items.some((m) => movieKey(m) === key)) return;
    items.push(movieClean);
    const watched = new Set(data.watched || []);
    const maybeLater = new Set(data.maybeLater || []);
    const archive = new Set(data.archive || []);
    if (s === "watched") watched.add(key);
    else if (s === "maybe-later") maybeLater.add(key);
    else if (s === "archive") archive.add(key);
    await setDoc(ref, { items, watched: [...watched], maybeLater: [...maybeLater], archive: [...archive] }, { merge: true });
  }
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
  const userWatched = new Set(userData.watched || []);
  const userMaybeLater = new Set(userData.maybeLater || []);
  const userArchive = new Set(userData.archive || []);

  if (userItems.length === 0) throw new Error("Your list is empty");

  const listRef = doc(db, "sharedLists", listId);
  const listSnap = await getDoc(listRef);
  const listDoc = listSnap.exists() ? listSnap.data() : {};
  const listItems = Array.isArray(listDoc.items) ? [...listDoc.items] : [];
  const listWatched = new Set(listDoc.watched || []);
  const listMaybeLater = new Set(listDoc.maybeLater || []);
  const listArchive = new Set(listDoc.archive || []);

  const existingKeys = new Set(listItems.map((m) => movieKey(m)));

  for (const m of userItems) {
    const key = movieKey(m);
    if (existingKeys.has(key)) continue;
    const { status, ...movie } = m;
    listItems.push(movie);
    existingKeys.add(key);
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

  if (listItems.length === 0) throw new Error("Shared list is empty");

  const userData = await getStatusData(uid);
  const userItems = Array.isArray(userData.items) ? [...userData.items] : [];
  const userWatched = new Set(userData.watched || []);
  const userMaybeLater = new Set(userData.maybeLater || []);
  const userArchive = new Set(userData.archive || []);

  const existingKeys = new Set(userItems.map((m) => movieKey(m)));

  for (const m of listItems) {
    const key = movieKey(m);
    if (existingKeys.has(key)) continue;
    const { status, ...movie } = m;
    userItems.push(movie);
    existingKeys.add(key);
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
    },
    { merge: true }
  );
}

/**
 * Move a single item from a shared list to the user's personal list.
 * Adds to personal if not there, removes from shared list.
 */
async function moveItemFromSharedToPersonal(uid, listId, movie) {
  const listData = await getSharedList(listId);
  if (!listData) throw new Error("Shared list not found");
  const members = Array.isArray(listData.members) ? listData.members : [];
  if (!members.includes(uid)) throw new Error("You are not a member of this shared list");

  const key = movieKey(movie);
  const userData = await getStatusData(uid);
  const userItems = Array.isArray(userData.items) ? [...userData.items] : [];
  const userWatched = new Set(userData.watched || []);
  const userMaybeLater = new Set(userData.maybeLater || []);
  const userArchive = new Set(userData.archive || []);

  const existingKeys = new Set(userItems.map((m) => movieKey(m)));
  if (!existingKeys.has(key)) {
    const { status, ...movieClean } = movie;
    userItems.push(movieClean);
    const s = status || "to-watch";
    if (s === "watched") userWatched.add(key);
    else if (s === "maybe-later") userMaybeLater.add(key);
    else if (s === "archive") userArchive.add(key);
  }

  const userRef = doc(db, "users", uid);
  await setDoc(
    userRef,
    {
      items: userItems,
      watched: [...userWatched],
      maybeLater: [...userMaybeLater],
      archive: [...userArchive],
    },
    { merge: true }
  );

  await removeFromSharedList(listId, key);
}

/**
 * Move a single item from the user's personal list to a shared list.
 * Adds to shared list, removes from personal list.
 */
async function moveItemFromPersonalToShared(uid, listId, movie) {
  const listData = await getSharedList(listId);
  if (!listData) throw new Error("Shared list not found");
  const members = Array.isArray(listData.members) ? listData.members : [];
  if (!members.includes(uid)) throw new Error("You are not a member of this shared list");

  const key = movieKey(movie);
  const userData = await getStatusData(uid);
  const userItems = Array.isArray(userData.items) ? userData.items : [];
  const userWatched = new Set(userData.watched || []);
  const userMaybeLater = new Set(userData.maybeLater || []);
  const userArchive = new Set(userData.archive || []);

  const existingKeys = new Set(userItems.map((m) => movieKey(m)));
  if (!existingKeys.has(key)) throw new Error("Movie not in your personal list");

  const listRef = doc(db, "sharedLists", listId);
  const listSnap = await getDoc(listRef);
  const listDoc = listSnap.exists() ? listSnap.data() : {};
  const listItems = Array.isArray(listDoc.items) ? [...listDoc.items] : [];
  const listWatched = new Set(listDoc.watched || []);
  const listMaybeLater = new Set(listDoc.maybeLater || []);
  const listArchive = new Set(listDoc.archive || []);
  const listKeys = new Set(listItems.map((m) => movieKey(m)));

  if (!listKeys.has(key)) {
    const { status, ...movieClean } = movie;
    listItems.push(movieClean);
    const s = status || "to-watch";
    if (s === "watched") listWatched.add(key);
    else if (s === "maybe-later") listMaybeLater.add(key);
    else if (s === "archive") listArchive.add(key);
    await setDoc(
      listRef,
      {
        items: listItems,
        watched: [...listWatched],
        maybeLater: [...listMaybeLater],
        archive: [...listArchive],
      },
      { merge: true }
    );
  }

  const newUserItems = userItems.filter((m) => movieKey(m) !== key);
  userWatched.delete(key);
  userMaybeLater.delete(key);
  userArchive.delete(key);
  const userRef = doc(db, "users", uid);
  await setDoc(
    userRef,
    {
      items: newUserItems,
      watched: [...userWatched],
      maybeLater: [...userMaybeLater],
      archive: [...userArchive],
    },
    { merge: true }
  );
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
    if (Array.isArray(updates.services)) items[idx].services = updates.services;
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
    if (Array.isArray(updates.services)) items[idx].services = updates.services;
    await setDoc(doc(db, "sharedLists", listId), { items }, { merge: true });
  }
}

/**
 * Create a new personal list. Never throws - returns null on failure.
 */
async function createPersonalList(uid, name) {
  try {
    const listId = randomId() + randomId();
    const ref = doc(db, "users", uid, "personalLists", listId);
    await setDoc(ref, {
      name: (name || "Personal list").trim(),
      items: [],
      watched: [],
      maybeLater: [],
      archive: [],
      createdAt: new Date().toISOString(),
    });
    return listId;
  } catch (e) {
    console.warn("createPersonalList failed:", e);
    return null;
  }
}

/**
 * Get all personal lists. Never throws - returns at least default list on any error.
 */
async function getPersonalLists(uid) {
  try {
    const defaultData = await getStatusData(uid);
    const defaultName = defaultData.listName || "My list";
    const defaultCount = Array.isArray(defaultData.items) ? defaultData.items.length : 0;
    const lists = [{ id: "personal", name: defaultName, count: defaultCount, isDefault: true }];
    try {
      const coll = collection(db, "users", uid, "personalLists");
      const snap = await getDocs(coll);
      for (const d of snap.docs) {
        const data = d.data();
        const items = Array.isArray(data.items) ? data.items : [];
        lists.push({ id: d.id, name: data.name || "Personal list", count: items.length, isDefault: false });
      }
    } catch (subErr) {
      console.warn("getPersonalLists subcollection read failed:", subErr);
    }
    return lists;
  } catch (e) {
    console.warn("getPersonalLists failed:", e);
    return [{ id: "personal", name: "My list", count: 0, isDefault: true }];
  }
}

/**
 * Get movies for a personal list.
 */
async function getPersonalListMovies(uid, listId) {
  if (listId === "personal") return getUserMovies(uid);
  try {
    const ref = doc(db, "users", uid, "personalLists", listId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return [];
    const data = snap.data();
    const items = Array.isArray(data.items) ? data.items : [];
    const watchedSet = new Set(data.watched || []);
    const maybeLaterSet = new Set(data.maybeLater || []);
    const archiveSet = new Set(data.archive || []);
    return mergeImdbIdsFromCatalog(
      items.map((m) => {
        const key = movieKey(m);
        let status = "to-watch";
        if (watchedSet.has(key)) status = "watched";
        else if (maybeLaterSet.has(key)) status = "maybe-later";
        else if (archiveSet.has(key)) status = "archive";
        return { ...m, status };
      })
    );
  } catch (e) {
    console.warn("getPersonalListMovies failed:", e);
    return [];
  }
}

async function setPersonalListStatus(uid, listId, key, status) {
  const ref = doc(db, "users", uid, "personalLists", listId);
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

async function removeFromPersonalList(uid, listId, key) {
  const ref = doc(db, "users", uid, "personalLists", listId);
  const snap = await getDoc(ref);
  const data = snap.exists() ? snap.data() : {};
  const items = Array.isArray(data.items) ? data.items.filter((m) => movieKey(m) !== key) : [];
  await setDoc(
    ref,
    {
      items,
      watched: arrayRemove(key),
      maybeLater: arrayRemove(key),
      archive: arrayRemove(key),
    },
    { merge: true }
  );
}

async function renamePersonalList(uid, listId, newName) {
  const name = String(newName || "").trim();
  if (!name) throw new Error("Name cannot be empty");
  if (listId === "personal") {
    await setDoc(doc(db, "users", uid), { listName: name }, { merge: true });
  } else {
    const ref = doc(db, "users", uid, "personalLists", listId);
    await setDoc(ref, { name }, { merge: true });
  }
}

async function deletePersonalList(uid, listId) {
  if (listId === "personal") {
    await setDoc(
      doc(db, "users", uid),
      { items: [], watched: [], maybeLater: [], archive: [] },
      { merge: true }
    );
  } else {
    const ref = doc(db, "users", uid, "personalLists", listId);
    await deleteDoc(ref);
  }
}

async function renameSharedList(listId, newName) {
  const name = String(newName || "").trim();
  if (!name) throw new Error("Name cannot be empty");
  await setDoc(doc(db, "sharedLists", listId), { name }, { merge: true });
}

async function deleteSharedList(listId) {
  await deleteDoc(doc(db, "sharedLists", listId));
}

/**
 * Leave a shared list. Removes the user from the list's members.
 */
async function leaveSharedList(uid, listId) {
  const listData = await getSharedList(listId);
  if (!listData) throw new Error("Shared list not found");
  const members = Array.isArray(listData.members) ? listData.members : [];
  if (!members.includes(uid)) throw new Error("You are not a member of this shared list");
  const ref = doc(db, "sharedLists", listId);
  await setDoc(ref, { members: arrayRemove(uid) }, { merge: true });
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
  const sharedKeys = new Set(listItems.map((m) => movieKey(m)));

  const userData = await getStatusData(uid);
  const userItems = Array.isArray(userData.items) ? userData.items : [];

  const toRemove = [];
  for (const m of userItems) {
    const key = movieKey(m);
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
  getUserProfile,
  setUserCountry,
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
  addToPersonalList,
  leaveSharedList,
  createPersonalList,
  getPersonalLists,
  getPersonalListMovies,
  setPersonalListStatus,
  removeFromPersonalList,
  renamePersonalList,
  deletePersonalList,
  renameSharedList,
  deleteSharedList,
  moveAllToSharedList,
  copySharedListToPersonal,
  moveItemFromSharedToPersonal,
  moveItemFromPersonalToShared,
  updateMovieMetadata,
  removeDuplicatesFromPersonal,
};
