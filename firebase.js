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
 * Returns the watched list from Firestore.
 * Data model: users/{uid}.watched = string[] (movie keys)
 * A movie is watched iff its key is in this array.
 */
async function getWatchedList(uid) {
  const ref = doc(db, "users", uid);
  const snap = await getDoc(ref);
  return snap.exists() && Array.isArray(snap.data().watched) ? snap.data().watched : [];
}

async function addWatched(uid, key) {
  const ref = doc(db, "users", uid);
  await setDoc(ref, { watched: arrayUnion(key) }, { merge: true });
}

async function removeWatched(uid, key) {
  const ref = doc(db, "users", uid);
  await setDoc(ref, { watched: arrayRemove(key) }, { merge: true });
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
  addWatched,
  removeWatched,
};
