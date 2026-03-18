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
 * Data model: users/{uid} = { watched: string[], maybeLater: string[], archive: string[], removed: string[] }
 * Status: to-watch (default), watched, maybe-later, archive. Removed titles are hidden unless viewing Removed tab.
 */
async function getStatusData(uid) {
  const ref = doc(db, "users", uid);
  const snap = await getDoc(ref);
  const data = snap.exists() ? snap.data() : {};
  return {
    watched: Array.isArray(data.watched) ? data.watched : [],
    maybeLater: Array.isArray(data.maybeLater) ? data.maybeLater : [],
    archive: Array.isArray(data.archive) ? data.archive : [],
    removed: Array.isArray(data.removed) ? data.removed : [],
  };
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
  getWatchedList,
  getStatusData,
  setStatus,
  addWatched,
  removeWatched,
  removeTitle,
};
