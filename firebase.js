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
};
