import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";
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
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  getDocs,
  arrayUnion,
  arrayRemove,
  deleteField,
} from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";

import { firebaseConfig } from "./config/firebase.js";
import { listKey as movieKey } from "./lib/registry-id.js";

const app = initializeApp(firebaseConfig);

function shouldLoadWebAnalytics() {
  if (typeof window === "undefined") return false;
  if (!firebaseConfig.measurementId) return false;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  try {
    if (import.meta.env?.DEV) return false;
  } catch {
    /* no import.meta (non-bundled edge case) */
  }
  return true;
}

if (shouldLoadWebAnalytics()) {
  import("https://www.gstatic.com/firebasejs/10.7.0/firebase-analytics.js")
    .then(({ getAnalytics, isSupported }) =>
      isSupported().then((ok) => {
        if (!ok) return;
        try {
          getAnalytics(app);
        } catch (e) {
          console.warn("Firebase Analytics disabled:", e?.message || e);
        }
      })
    )
    .catch(() => {
      /* blocked script, offline, or import failure */
    });
}

const auth = getAuth(app);
const db = getFirestore(app);

/** Legacy status key when items were embedded (no registryId). */
function titleYearKey(m) {
  return `${m?.title ?? ""}|${m?.year ?? ""}`;
}

const REGISTRY_READ_BATCH = 30;

async function bulkGetTitleRegistryDocData(ids) {
  const unique = [...new Set((ids || []).filter(Boolean).map((id) => String(id)))];
  const map = new Map();
  for (let i = 0; i < unique.length; i += REGISTRY_READ_BATCH) {
    const slice = unique.slice(i, i + REGISTRY_READ_BATCH);
    await Promise.all(
      slice.map(async (id) => {
        try {
          const snap = await getDoc(doc(db, "titleRegistry", id));
          if (snap.exists()) map.set(id, snap.data());
        } catch (e) {
          console.warn("titleRegistry read failed:", id, e?.message || e);
        }
      })
    );
  }
  return map;
}

/**
 * Expand list rows: `{ registryId }` → merged metadata from titleRegistry;
 * legacy embedded rows → title|year status keys (embedded fields only; no catalog).
 */
async function hydrateListItemsFromRegistry(items, watchedSet, maybeLaterSet, archiveSet) {
  const refs = [];
  const legacy = [];
  for (const m of items || []) {
    if (!m || typeof m !== "object") continue;
    const rid = m.registryId;
    if (rid != null && rid !== "") refs.push(m);
    else legacy.push(m);
  }

  const regMap = await bulkGetTitleRegistryDocData(refs.map((r) => r.registryId));
  const out = [];

  for (const r of refs) {
    const rid = String(r.registryId);
    const fromRegistry = regMap.get(rid) || {};
    /** Inline fields saved on the list row (legacy / partial rows) fill gaps if registry is missing. */
    const { registryId: _ignore, status: _st, ...inline } = r;
    const meta = { ...inline, ...fromRegistry };
    let status = "to-watch";
    if (watchedSet.has(rid)) status = "watched";
    else if (maybeLaterSet.has(rid)) status = "maybe-later";
    else if (archiveSet.has(rid)) status = "archive";
    out.push({
      ...meta,
      registryId: rid,
      title: meta.title ?? "Unknown",
      year: meta.year ?? null,
      type: meta.type ?? "movie",
      genre: meta.genre ?? "",
      thumb: meta.thumb ?? null,
      youtubeId: meta.youtubeId ?? null,
      imdbId: meta.imdbId ?? null,
      tmdbId: meta.tmdbId ?? null,
      tmdbMedia: meta.tmdbMedia ?? null,
      services: Array.isArray(meta.services) ? meta.services : [],
      servicesByRegion: meta.servicesByRegion,
      status,
    });
  }

  const legacyMerged = legacy.map((m) => ({ ...m }));
  for (const m of legacyMerged) {
    const k = titleYearKey(m);
    let status = "to-watch";
    if (watchedSet.has(k)) status = "watched";
    else if (maybeLaterSet.has(k)) status = "maybe-later";
    else if (archiveSet.has(k)) status = "archive";
    out.push({ ...m, status });
  }

  const rawCount = (items || []).filter((m) => m != null).length;
  if (rawCount > 0 && out.length === 0) {
    console.error(
      "hydrateListItemsFromRegistry: Firestore had list items but none could be hydrated. Check document shapes or deploy firestore.rules (titleRegistry read).",
      { rawCount, firstItem: items[0] }
    );
  }

  return out;
}

/** Persisted list row: reference only when registryId is known; else legacy embedded doc. */
function rowToStore(movie) {
  if (!movie || typeof movie !== "object") return {};
  if (movie.registryId) return { registryId: movie.registryId };
  const { status, ...clean } = movie;
  return clean;
}

function randomId() {
  return Math.random().toString(36).slice(2, 12);
}

function requirePersistedListName(name, label = "List name") {
  const n = String(name ?? "").trim();
  if (!n) throw new Error(`${label} is required`);
  return n;
}

/**
 * Personal list rows live on users/{uid}/personalLists/{listId} (same shape as sharedLists).
 * users/{uid} holds profile + defaultPersonalListId only.
 * One-time move from legacy users/{uid}.items → default subdoc.
 */
async function migrateLegacyPersonalListIfNeeded(uid) {
  const userRef = doc(db, "users", uid);
  const userSnap = await getDoc(userRef);
  if (!userSnap.exists()) return;
  const data = userSnap.data() || {};

  let defId = typeof data.defaultPersonalListId === "string" ? data.defaultPersonalListId.trim() : "";
  if (defId) {
    const plSnap = await getDoc(doc(db, "users", uid, "personalLists", defId));
    if (plSnap.exists()) return;
    await updateDoc(userRef, { defaultPersonalListId: deleteField() });
  }

  const collSnap = await getDocs(collection(db, "users", uid, "personalLists"));
  if (collSnap.docs.length === 1) {
    const onlyId = collSnap.docs[0].id;
    await setDoc(userRef, { defaultPersonalListId: onlyId }, { merge: true });
    return;
  }

  const items = Array.isArray(data.items) ? data.items : [];
  const watched = Array.isArray(data.watched) ? data.watched : [];
  const maybeLater = Array.isArray(data.maybeLater) ? data.maybeLater : [];
  const archive = Array.isArray(data.archive) ? data.archive : [];
  const listName = typeof data.listName === "string" ? data.listName.trim() : "";

  const hasPayload =
    items.length > 0 ||
    watched.length > 0 ||
    maybeLater.length > 0 ||
    archive.length > 0 ||
    listName.length > 0;

  if (!hasPayload) return;

  const newId = randomId() + randomId();
  const plRef = doc(db, "users", uid, "personalLists", newId);
  await setDoc(plRef, {
    name: listName,
    items,
    watched,
    maybeLater,
    archive,
    createdAt: new Date().toISOString(),
  });
  await updateDoc(userRef, {
    defaultPersonalListId: newId,
    items: deleteField(),
    watched: deleteField(),
    maybeLater: deleteField(),
    archive: deleteField(),
    listName: deleteField(),
  });
}

async function resolveDefaultPersonalListId(uid) {
  await migrateLegacyPersonalListIfNeeded(uid);
  const userSnap = await getDoc(doc(db, "users", uid));
  if (!userSnap.exists()) return "";
  const raw = userSnap.data().defaultPersonalListId;
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!id) return "";
  const plSnap = await getDoc(doc(db, "users", uid, "personalLists", id));
  return plSnap.exists() ? id : "";
}

/**
 * Returns status for the user's default personal list + profile fields from users/{uid}.
 */
async function getStatusData(uid) {
  const userRef = doc(db, "users", uid);
  const snap = await getDoc(userRef);
  const data = snap.exists() ? snap.data() : {};
  const defaultId = await resolveDefaultPersonalListId(uid);

  let items = [];
  let watched = [];
  let maybeLater = [];
  let archive = [];
  let listName = "";
  if (defaultId) {
    const plSnap = await getDoc(doc(db, "users", uid, "personalLists", defaultId));
    if (plSnap.exists()) {
      const ld = plSnap.data();
      items = Array.isArray(ld.items) ? ld.items : [];
      watched = Array.isArray(ld.watched) ? ld.watched : [];
      maybeLater = Array.isArray(ld.maybeLater) ? ld.maybeLater : [];
      archive = Array.isArray(ld.archive) ? ld.archive : [];
      listName = typeof ld.name === "string" ? ld.name.trim() : "";
    }
  }

  return {
    items,
    watched,
    maybeLater,
    archive,
    listName,
    defaultPersonalListId: defaultId || null,
    country: data.country || null,
    countryName: data.countryName || null,
    upcomingDismissals:
      data.upcomingDismissals && typeof data.upcomingDismissals === "object" ? data.upcomingDismissals : {},
  };
}

async function getUserProfile(uid) {
  const ref = doc(db, "users", uid);
  const snap = await getDoc(ref);
  const data = snap.exists() ? snap.data() : {};
  const defaultId = await resolveDefaultPersonalListId(uid);
  let listName = "";
  if (defaultId) {
    const plSnap = await getDoc(doc(db, "users", uid, "personalLists", defaultId));
    if (plSnap.exists()) {
      const n = plSnap.data().name;
      listName = typeof n === "string" ? n.trim() : "";
    }
  }
  return {
    country: data.country || null,
    countryName: data.countryName || null,
    listName,
    defaultPersonalListId: defaultId || null,
  };
}

async function setUserCountry(uid, countryCode, countryName) {
  const ref = doc(db, "users", uid);
  await setDoc(ref, { country: countryCode, countryName: countryName || countryCode }, { merge: true });
}

async function setStatus(uid, key, status) {
  const listId = await resolveDefaultPersonalListId(uid);
  if (!listId) throw new Error("No personal list. Open the app and name your list first.");
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

async function removeTitle(uid, key) {
  const listId = await resolveDefaultPersonalListId(uid);
  if (!listId) return;
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

// --- Shared lists ---

async function createSharedList(uid, name) {
  const persistedName = requirePersistedListName(name, "List name");
  const listId = randomId() + randomId();
  const ref = doc(db, "sharedLists", listId);
  await setDoc(ref, {
    name: persistedName,
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
  const data = snap.data();
  const name = typeof data.name === "string" ? data.name.trim() : "";
  return { id: listId, ...data, name };
}

async function getSharedListsForUser(uid) {
  const q = query(
    collection(db, "sharedLists"),
    where("members", "array-contains", uid)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => {
    const data = d.data();
    const name = typeof data.name === "string" ? data.name.trim() : "";
    return { id: d.id, ...data, name };
  });
}

async function getSharedListMovies(listId) {
  const data = await getSharedList(listId);
  if (!data) return [];
  const items = Array.isArray(data.items) ? data.items : [];
  const watchedSet = new Set(data.watched || []);
  const maybeLaterSet = new Set(data.maybeLater || []);
  const archiveSet = new Set(data.archive || []);
  return hydrateListItemsFromRegistry(items, watchedSet, maybeLaterSet, archiveSet);
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
  items.push(rowToStore(movie));
  const watched = new Set(data.watched || []);
  const maybeLater = new Set(data.maybeLater || []);
  const archive = new Set(data.archive || []);
  const s = movie.status || "to-watch";
  if (s === "watched") watched.add(key);
  else if (s === "maybe-later") maybeLater.add(key);
  else if (s === "archive") archive.add(key);
  await setDoc(ref, { items, watched: [...watched], maybeLater: [...maybeLater], archive: [...archive] }, { merge: true });
}

async function addToPersonalList(uid, listId, movie) {
  const key = movieKey(movie);
  const s = movie.status || "to-watch";
  if (listId === "personal") {
    const resolved = await resolveDefaultPersonalListId(uid);
    if (!resolved) throw new Error("No personal list. Open the app and name your list first.");
    const ref = doc(db, "users", uid, "personalLists", resolved);
    const snap = await getDoc(ref);
    const data = snap.exists() ? snap.data() : {};
    const items = Array.isArray(data.items) ? [...data.items] : [];
    if (items.some((m) => movieKey(m) === key)) return;
    items.push(rowToStore(movie));
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
    items.push(rowToStore(movie));
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
 * Create a new personal list (subcollection). Requires a non-empty trimmed name.
 */
async function createPersonalList(uid, name) {
  const persistedName = requirePersistedListName(name, "List name");
  const listId = randomId() + randomId();
  const ref = doc(db, "users", uid, "personalLists", listId);
  await setDoc(ref, {
    name: persistedName,
    items: [],
    watched: [],
    maybeLater: [],
    archive: [],
    createdAt: new Date().toISOString(),
  });
  return listId;
}

/**
 * Get all personal lists. Never throws - returns default list (virtual id "personal") plus other subcollection lists.
 */
async function getPersonalLists(uid) {
  try {
    await migrateLegacyPersonalListIfNeeded(uid);
    const userSnap = await getDoc(doc(db, "users", uid));
    const data = userSnap.exists() ? userSnap.data() : {};
    const defaultId = typeof data.defaultPersonalListId === "string" ? data.defaultPersonalListId.trim() : "";
    const lists = [];
    if (defaultId) {
      const plSnap = await getDoc(doc(db, "users", uid, "personalLists", defaultId));
      let defaultName = "";
      let defaultCount = 0;
      if (plSnap.exists()) {
        const ld = plSnap.data();
        defaultName = typeof ld.name === "string" ? ld.name.trim() : "";
        defaultCount = Array.isArray(ld.items) ? ld.items.length : 0;
      }
      lists.push({ id: "personal", name: defaultName, count: defaultCount, isDefault: true });
    } else {
      lists.push({ id: "personal", name: "", count: 0, isDefault: true });
    }
    try {
      const coll = collection(db, "users", uid, "personalLists");
      const snap = await getDocs(coll);
      for (const d of snap.docs) {
        if (d.id === defaultId) continue;
        const pdata = d.data();
        const items = Array.isArray(pdata.items) ? pdata.items : [];
        const subName = typeof pdata.name === "string" ? pdata.name.trim() : "";
        lists.push({ id: d.id, name: subName, count: items.length, isDefault: false });
      }
    } catch (subErr) {
      console.warn("getPersonalLists subcollection read failed:", subErr);
    }
    return lists;
  } catch (e) {
    console.warn("getPersonalLists failed:", e);
    return [{ id: "personal", name: "", count: 0, isDefault: true }];
  }
}

/**
 * Get movies for a personal list.
 */
async function getPersonalListMovies(uid, listId) {
  let targetId = listId;
  if (listId === "personal") {
    targetId = await resolveDefaultPersonalListId(uid);
    if (!targetId) return [];
  }
  try {
    const ref = doc(db, "users", uid, "personalLists", targetId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return [];
    const data = snap.data();
    const items = Array.isArray(data.items) ? data.items : [];
    const watchedSet = new Set(data.watched || []);
    const maybeLaterSet = new Set(data.maybeLater || []);
    const archiveSet = new Set(data.archive || []);
    return hydrateListItemsFromRegistry(items, watchedSet, maybeLaterSet, archiveSet);
  } catch (e) {
    console.warn("getPersonalListMovies failed:", e);
    return [];
  }
}

async function setPersonalListStatus(uid, listId, key, status) {
  if (listId === "personal") {
    await setStatus(uid, key, status);
    return;
  }
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
  if (listId === "personal") {
    await removeTitle(uid, key);
    return;
  }
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
    let id = await resolveDefaultPersonalListId(uid);
    if (!id) {
      const newId = randomId() + randomId();
      await setDoc(doc(db, "users", uid, "personalLists", newId), {
        name,
        items: [],
        watched: [],
        maybeLater: [],
        archive: [],
        createdAt: new Date().toISOString(),
      });
      await setDoc(doc(db, "users", uid), { defaultPersonalListId: newId }, { merge: true });
    } else {
      await setDoc(doc(db, "users", uid, "personalLists", id), { name }, { merge: true });
    }
  } else {
    const ref = doc(db, "users", uid, "personalLists", listId);
    await setDoc(ref, { name }, { merge: true });
  }
}

async function deletePersonalList(uid, listId) {
  if (listId === "personal") {
    const id = await resolveDefaultPersonalListId(uid);
    if (!id) return;
    await setDoc(
      doc(db, "users", uid, "personalLists", id),
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

/** @returns {{ tmdbId: number, media: 'tv'|'movie' } | null} */
function listItemToUpcomingPair(m) {
  if (!m || typeof m !== "object") return null;
  const t = m.tmdbId;
  if (t == null || t === "") return null;
  const n = Number(t);
  if (Number.isNaN(n)) return null;
  const isTv = m.tmdbMedia === "tv" || m.type === "show";
  return { tmdbId: n, media: isTv ? "tv" : "movie" };
}

/**
 * Fetch upcomingAlerts for list rows (catalogTmdbId + media match). Chunks Firestore `in` (max 10).
 * @param {object[]} items — current list movies
 */
async function fetchUpcomingAlertsForItems(items) {
  const pairKeys = new Set();
  const tmdbIds = new Set();
  for (const m of items || []) {
    const p = listItemToUpcomingPair(m);
    if (!p) continue;
    pairKeys.add(`${p.tmdbId}|${p.media}`);
    tmdbIds.add(p.tmdbId);
  }
  if (tmdbIds.size === 0) return [];

  const ids = [...tmdbIds];
  const CHUNK = 10;
  /** @type {Map<string, object>} */
  const byId = new Map();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const q = query(collection(db, "upcomingAlerts"), where("catalogTmdbId", "in", chunk));
    const snap = await getDocs(q);
    snap.forEach((d) => {
      byId.set(d.id, { id: d.id, ...d.data() });
    });
  }

  const today = new Date().toISOString().slice(0, 10);
  const out = [];
  for (const a of byId.values()) {
    const c = a.catalogTmdbId;
    const med = a.media;
    if (c == null || !med) continue;
    if (!pairKeys.has(`${c}|${med}`)) continue;
    if (a.expiresAt && String(a.expiresAt) < today) continue;
    out.push(a);
  }
  return out;
}

/**
 * Persist dismissal fingerprint on users/{uid}.upcomingDismissals.{fingerprint}
 */
async function dismissUpcomingAlert(uid, fingerprint) {
  if (!uid || !fingerprint) return;
  const day = new Date().toISOString().slice(0, 10);
  const ref = doc(db, "users", uid);
  await setDoc(ref, { upcomingDismissals: { [String(fingerprint)]: day } }, { merge: true });
}

/**
 * Real Firestore id under users/{uid}/personalLists/{id} for bookmarklet cookies.
 * Pass listId "personal" for the default list, or an existing subcollection id.
 */
async function getBookmarkletPersonalListFirestoreId(uid, listIdOrAlias) {
  if (listIdOrAlias === "personal") {
    return (await resolveDefaultPersonalListId(uid)) || null;
  }
  return listIdOrAlias || null;
}

export {
  auth,
  signInWithPopup,
  GoogleAuthProvider,
  fbSignOut,
  onAuthStateChanged,
  movieKey,
  getStatusData,
  getUserProfile,
  setUserCountry,
  setStatus,
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
  fetchUpcomingAlertsForItems,
  dismissUpcomingAlert,
  getBookmarkletPersonalListFirestoreId,
};
