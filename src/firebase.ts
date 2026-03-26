import { getApp, getApps, initializeApp } from "firebase/app";
import {
  getAuth,
  signInWithPopup,
  GoogleAuthProvider,
  signOut as fbSignOut,
  onAuthStateChanged,
} from "firebase/auth";
import {
  initializeFirestore,
  getFirestore,
  memoryLocalCache,
  persistentLocalCache,
  doc,
  getDoc,
  getDocFromServer,
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
  writeBatch,
} from "firebase/firestore";
import type { DocumentData, DocumentReference, DocumentSnapshot, Firestore } from "firebase/firestore";

import { firebaseConfig } from "./config/firebase.js";
import { listKey as movieKey } from "./lib/registry-id.js";
import { logEvent } from "./lib/axiom-logger.js";
import type {
  FirestoreListRow,
  MediaType,
  PersonalList,
  SharedList,
  StatusData,
  UpcomingAlert,
  UserProfile,
  WatchlistItem,
} from "./types/index.js";

type JobConfigState = {
  checkUpcomingEnabled: boolean;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunMessage: string | null;
  lastRunResult: Record<string, unknown> | null;
};

/**
 * Map a `sharedLists/{id}` snapshot to `SharedList`.
 * Firestore returns `DocumentData` (untyped); safe cast because this client and Netlify functions
 * are the only writers and persist `SharedList`-compatible fields.
 */
function sharedListFromFirestoreDoc(listId: string, data: DocumentData): SharedList {
  const name = typeof data.name === "string" ? data.name.trim() : "";
  const rest = data as Omit<SharedList, "id" | "name">;
  return { id: listId, ...rest, name };
}

/**
 * Map merged `{ id, ...docData }` to `UpcomingAlert`.
 * Cast is safe: `upcomingAlerts` docs are created by the check-upcoming pipeline with this schema.
 */
function upcomingAlertFromMergedDoc(merged: DocumentData & { id: string }): UpcomingAlert {
  return merged as UpcomingAlert;
}

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

function shouldLoadWebAnalytics(): boolean {
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
  import("firebase/analytics")
    .then(({ getAnalytics, isSupported }) =>
      isSupported().then((ok) => {
        if (!ok) return;
        try {
          getAnalytics(app);
        } catch (e: unknown) {
          console.warn("Firebase Analytics disabled:", e instanceof Error ? e.message : e);
        }
      })
    )
    .catch(() => {
      /* blocked script, offline, or import failure */
    });
}

function initFirestoreWithLocalCache(): Firestore {
  const globalKey = "__movieTrailerFirestoreDb";
  const globalObj = globalThis as typeof globalThis & { [globalKey]?: Firestore };
  if (globalObj[globalKey]) return globalObj[globalKey];

  function useExistingFirestore(): Firestore {
    const existing = getFirestore(app);
    globalObj[globalKey] = existing;
    return existing;
  }

  try {
    const persistentDb = initializeFirestore(app, { localCache: persistentLocalCache() });
    globalObj[globalKey] = persistentDb;
    return persistentDb;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err ?? "");
    if (/initializeFirestore\(\) has already been called with different options/i.test(message)) {
      return useExistingFirestore();
    }
    const code =
      err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code ?? "") : "";
    if (code !== "failed-precondition" && code !== "unimplemented") {
      throw err;
    }
    try {
      const memoryDb = initializeFirestore(app, { localCache: memoryLocalCache() });
      globalObj[globalKey] = memoryDb;
      return memoryDb;
    } catch (fallbackErr: unknown) {
      const fallbackMessage = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr ?? "");
      if (/initializeFirestore\(\) has already been called with different options/i.test(fallbackMessage)) {
        return useExistingFirestore();
      }
      throw fallbackErr;
    }
  }
}

const auth = getAuth(app);
const db: Firestore = initFirestoreWithLocalCache();

/** Lowercase email key for `allowedUsers/{email}` document ids. */
function normalizeUserEmailKey(email: string): string {
  return String(email || "")
    .trim()
    .toLowerCase();
}

/** Returns true if `allowedUsers/{normalizedEmail}` exists (invite / seed allowlist). */
async function checkUserAllowed(email: string | null | undefined): Promise<boolean> {
  if (email == null || typeof email !== "string") return false;
  const key = normalizeUserEmailKey(email);
  if (!key) return false;
  const snap = await getDoc(doc(db, "allowedUsers", key));
  return snap.exists();
}

async function getIdTokenForApi(): Promise<string | null> {
  const u = auth.currentUser;
  if (!u) return null;
  try {
    return await u.getIdToken();
  } catch {
    return null;
  }
}

/** Stored list rows: registry refs, legacy embeds, or hydrated client rows re-saved with the same keys. */
type ListRowForHydrate = FirestoreListRow | WatchlistItem;

/** Legacy status key when items were embedded (no registryId). */
function titleYearKey(m: ListRowForHydrate | null | undefined): string {
  if (!m || typeof m !== "object") return "|";
  const rec = m as Record<string, unknown>;
  return `${rec.title ?? ""}|${rec.year ?? ""}`;
}

/** Firestore list row only — must survive hydrate `out.push` (spread + explicit fields). */
function addedByUidFromListRow(r: ListRowForHydrate): string | undefined {
  const v = (r as Record<string, unknown>).addedByUid;
  if (typeof v === "string" && v.trim()) return v.trim();
  return undefined;
}

function addedByDisplayNameFromListRow(r: ListRowForHydrate): string | undefined {
  const v = (r as Record<string, unknown>).addedByDisplayName;
  if (typeof v === "string" && v.trim()) return v.trim();
  return undefined;
}

function addedByPhotoUrlFromListRow(r: ListRowForHydrate): string | undefined {
  const v = (r as Record<string, unknown>).addedByPhotoUrl;
  if (typeof v === "string" && v.trim()) return v.trim();
  return undefined;
}

function normalizeAddedAt(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

function ensureAddedAt(value: unknown): string {
  return normalizeAddedAt(value) ?? new Date().toISOString();
}

const REGISTRY_READ_BATCH = 30;

async function bulkGetTitleRegistryDocData(ids: readonly string[]): Promise<Map<string, DocumentData>> {
  const unique = [...new Set(ids.filter(Boolean).map((id) => String(id)))];
  const map = new Map<string, DocumentData>();
  for (let i = 0; i < unique.length; i += REGISTRY_READ_BATCH) {
    const slice = unique.slice(i, i + REGISTRY_READ_BATCH);
    await Promise.all(
      slice.map(async (id) => {
        try {
          const snap = await getDoc(doc(db, "titleRegistry", id));
          if (snap.exists()) map.set(id, snap.data());
        } catch (e: unknown) {
          console.warn("titleRegistry read failed:", id, e instanceof Error ? e.message : e);
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
async function hydrateListItemsFromRegistry(
  items: readonly ListRowForHydrate[] | undefined,
  watchedSet: Set<string>,
  maybeLaterSet: Set<string>,
  archiveSet: Set<string>
): Promise<WatchlistItem[]> {
  const refs: ListRowForHydrate[] = [];
  const legacy: ListRowForHydrate[] = [];
  for (const m of items || []) {
    if (!m || typeof m !== "object") continue;
    const rid = m.registryId;
    if (rid != null && rid !== "") refs.push(m);
    else legacy.push(m);
  }

  const regMap = await bulkGetTitleRegistryDocData(refs.map((r) => String(r.registryId)));
  const out: WatchlistItem[] = [];

  for (const r of refs) {
    const rid = String(r.registryId);
    const fromRegistry: DocumentData = regMap.get(rid) ?? {};
    /** Inline fields saved on the list row (legacy / partial rows) fill gaps if registry is missing. */
    const { registryId: _ignore, status: _st, ...inline } = r as ListRowForHydrate & {
      registryId?: string;
      status?: unknown;
    };
    const meta: Record<string, unknown> = { ...inline, ...fromRegistry };
    /** List row: `addedBy*` denormalized on shared list items; titleRegistry must not override. */
    if (typeof inline.addedByUid === "string" && inline.addedByUid.trim()) meta.addedByUid = inline.addedByUid.trim();
    else delete meta.addedByUid;
    const rowAddedByName = addedByDisplayNameFromListRow(r);
    const rowAddedByPhoto = addedByPhotoUrlFromListRow(r);
    if (rowAddedByName) meta.addedByDisplayName = rowAddedByName;
    else delete meta.addedByDisplayName;
    if (rowAddedByPhoto) meta.addedByPhotoUrl = rowAddedByPhoto;
    else delete meta.addedByPhotoUrl;
    let status: WatchlistItem["status"] = "to-watch";
    if (watchedSet.has(rid)) status = "watched";
    else if (maybeLaterSet.has(rid)) status = "maybe-later";
    else if (archiveSet.has(rid)) status = "archive";
    const mediaType: MediaType = meta.type === "show" ? "show" : "movie";
    const rowAddedBy = addedByUidFromListRow(r);
    out.push({
      ...meta,
      registryId: rid,
      addedAt: normalizeAddedAt(meta.addedAt),
      title: typeof meta.title === "string" ? meta.title : "Unknown",
      year: (() => {
        if (meta.year == null || meta.year === "") return null;
        const n = Number(meta.year);
        return Number.isNaN(n) ? null : n;
      })(),
      type: mediaType,
      genre: typeof meta.genre === "string" ? meta.genre : "",
      thumb: meta.thumb != null ? String(meta.thumb) : null,
      youtubeId: meta.youtubeId != null ? String(meta.youtubeId) : null,
      imdbId: meta.imdbId != null && meta.imdbId !== "" ? String(meta.imdbId) : null,
      tmdbId:
        meta.tmdbId != null && meta.tmdbId !== "" && !Number.isNaN(Number(meta.tmdbId))
          ? Number(meta.tmdbId)
          : null,
      tmdbMedia: meta.tmdbMedia != null ? String(meta.tmdbMedia) : null,
      services: Array.isArray(meta.services) ? (meta.services as unknown[]).map((s) => String(s)) : [],
      servicesByRegion:
        meta.servicesByRegion != null && typeof meta.servicesByRegion === "object"
          ? (meta.servicesByRegion as WatchlistItem["servicesByRegion"])
          : null,
      status,
      ...(rowAddedBy ? { addedByUid: rowAddedBy } : {}),
      ...(rowAddedByName ? { addedByDisplayName: rowAddedByName } : {}),
      ...(rowAddedByPhoto ? { addedByPhotoUrl: rowAddedByPhoto } : {}),
    });
  }

  const legacyMerged = legacy.map((m) => ({ ...m }));
  for (const m of legacyMerged) {
    const k = titleYearKey(m);
    let status: WatchlistItem["status"] = "to-watch";
    if (watchedSet.has(k)) status = "watched";
    else if (maybeLaterSet.has(k)) status = "maybe-later";
    else if (archiveSet.has(k)) status = "archive";
    // Legacy embedded rows: shape varies; runtime matches historical Firestore embeds.
    const legacyMeta = m as Record<string, unknown>;
    out.push({ ...legacyMeta, addedAt: normalizeAddedAt(legacyMeta.addedAt), status } as WatchlistItem);
  }

  const rawCount = (items || []).filter((m) => m != null).length;
  if (rawCount > 0 && out.length === 0) {
    const first = items?.[0];
    console.error(
      "hydrateListItemsFromRegistry: Firestore had list items but none could be hydrated. Check document shapes or deploy firestore.rules (titleRegistry read).",
      { rawCount, firstItem: first }
    );
  }

  return out;
}

/** Persisted list row: reference only when registryId is known; else legacy embedded doc. */
function rowToStore(movie: WatchlistItem | FirestoreListRow | null | undefined): FirestoreListRow {
  if (!movie || typeof movie !== "object") return {};
  const rec = movie as Record<string, unknown>;
  if (movie.registryId) return { registryId: movie.registryId, addedAt: ensureAddedAt(rec.addedAt) };
  const { status: _status, ...clean } = movie as FirestoreListRow & { status?: unknown };
  return { ...clean, addedAt: ensureAddedAt((clean as Record<string, unknown>).addedAt) };
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 12);
}

function requirePersistedListName(name: unknown, label = "List name"): string {
  const n = String(name ?? "").trim();
  if (!n) throw new Error(`${label} is required`);
  return n;
}

/**
 * Personal list rows live on users/{uid}/personalLists/{listId} (same shape as sharedLists).
 * users/{uid} holds profile + defaultPersonalListId only.
 * One-time move from legacy users/{uid}.items → default subdoc.
 */
async function migrateLegacyPersonalListIfNeeded(uid: string): Promise<void> {
  const userRef = doc(db, "users", uid);
  const userSnap = await getDoc(userRef);
  if (!userSnap.exists()) return;
  const data = userSnap.data() ?? {};

  let defId = typeof data.defaultPersonalListId === "string" ? data.defaultPersonalListId.trim() : "";
  if (defId) {
    const plSnap = await getDoc(doc(db, "users", uid, "personalLists", defId));
    if (plSnap.exists()) return;
    await updateDoc(userRef, { defaultPersonalListId: deleteField() });
  }

  const collSnap = await getDocs(collection(db, "users", uid, "personalLists"));
  if (collSnap.docs.length === 1) {
    const onlyDoc = collSnap.docs[0];
    if (onlyDoc) await setDoc(userRef, { defaultPersonalListId: onlyDoc.id }, { merge: true });
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

async function resolveDefaultPersonalListId(uid: string): Promise<string> {
  await migrateLegacyPersonalListIfNeeded(uid);
  const userSnap = await getDoc(doc(db, "users", uid));
  if (!userSnap.exists()) return "";
  const raw = userSnap.data()?.defaultPersonalListId;
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!id) return "";
  const plSnap = await getDoc(doc(db, "users", uid, "personalLists", id));
  return plSnap.exists() ? id : "";
}

/**
 * Returns status for the user's default personal list + profile fields from users/{uid}.
 */
async function getStatusData(uid: string): Promise<StatusData> {
  const userRef = doc(db, "users", uid);
  const snap = await getDoc(userRef);
  const data: DocumentData = snap.exists() ? snap.data() : {};
  const defaultId = await resolveDefaultPersonalListId(uid);

  let items: FirestoreListRow[] = [];
  let watched: string[] = [];
  let maybeLater: string[] = [];
  let archive: string[] = [];
  let listName = "";
  if (defaultId) {
    const plSnap = await getDoc(doc(db, "users", uid, "personalLists", defaultId));
    if (plSnap.exists()) {
      const ld = plSnap.data();
      // `DocumentData.items` is untyped; rows are registry refs or legacy embeds as in `FirestoreListRow`.
      items = (Array.isArray(ld.items) ? ld.items : []) as FirestoreListRow[];
      watched = (Array.isArray(ld.watched) ? ld.watched : []).map((k) => String(k));
      maybeLater = (Array.isArray(ld.maybeLater) ? ld.maybeLater : []).map((k) => String(k));
      archive = (Array.isArray(ld.archive) ? ld.archive : []).map((k) => String(k));
      listName = typeof ld.name === "string" ? ld.name.trim() : "";
    }
  }

  const dismissRaw = data.upcomingDismissals;
  // Map field values are ISO date strings written by dismissUpcomingAlert; keys are fingerprints.
  const upcomingDismissals: Record<string, string> =
    dismissRaw && typeof dismissRaw === "object" && !Array.isArray(dismissRaw)
      ? (dismissRaw as Record<string, string>)
      : {};

  return {
    items,
    watched,
    maybeLater,
    archive,
    listName,
    defaultPersonalListId: defaultId || null,
    country: data.country != null ? String(data.country) : null,
    countryName: data.countryName != null ? String(data.countryName) : null,
    upcomingDismissals,
  };
}

async function getUserProfile(uid: string): Promise<UserProfile> {
  const ref = doc(db, "users", uid);
  const snap = await getDoc(ref);
  const data: DocumentData = snap.exists() ? snap.data() : {};
  const defaultId = await resolveDefaultPersonalListId(uid);
  let listName = "";
  if (defaultId) {
    const plSnap = await getDoc(doc(db, "users", uid, "personalLists", defaultId));
    if (plSnap.exists()) {
      const n = plSnap.data().name;
      listName = typeof n === "string" ? n.trim() : "";
    }
  }
  const displayName = displayNameFromUserDoc(data) || null;
  const photoURL = photoUrlFromUserDoc(data);

  const dismissRaw = data.upcomingDismissals;
  const upcomingDismissals: Record<string, string> =
    dismissRaw && typeof dismissRaw === "object" && !Array.isArray(dismissRaw)
      ? (dismissRaw as Record<string, string>)
      : {};

  const phoneRaw = data.phoneNumbers;
  const phoneNumbersParsed = Array.isArray(phoneRaw)
    ? phoneRaw.map((x) => String(x).replace(/\D/g, "")).filter(Boolean)
    : [];

  const out: UserProfile = {
    country: data.country != null ? String(data.country) : null,
    countryName: data.countryName != null ? String(data.countryName) : null,
    displayName,
    photoURL,
    listName,
    defaultPersonalListId: defaultId || null,
    upcomingDismissals,
  };
  if (phoneNumbersParsed.length > 0) {
    out.phoneNumbers = phoneNumbersParsed;
  }
  return out;
}

/** Writes `users/{uid}.displayName` and optionally `photoURL` from Firebase Auth (shared-list “added by” + avatars). */
async function syncUserDisplayNameToFirestore(
  uid: string,
  label: string | null | undefined,
  authPhotoURL?: string | null
): Promise<void> {
  const raw = typeof label === "string" ? label.trim() : "";
  const payload: Record<string, unknown> = {};
  if (raw) payload.displayName = raw;
  if (authPhotoURL !== undefined) {
    const photoRaw = typeof authPhotoURL === "string" ? authPhotoURL.trim() : "";
    payload.photoURL = photoRaw ? photoRaw : deleteField();
  }
  if (Object.keys(payload).length === 0) return;
  await setDoc(doc(db, "users", uid), payload, { merge: true });
}

type AddedByUserFields = { displayName: string; photoURL: string | null };

function displayNameFromUserDoc(d: DocumentData | undefined): string {
  if (!d || typeof d !== "object") return "";
  const n = (d as Record<string, unknown>).displayName;
  return typeof n === "string" && n.trim() ? n.trim() : "";
}

/** Accept `photoURL` (Auth sync) or occasional `photoUrl` casing in Firestore. */
function photoUrlFromUserDoc(d: DocumentData | undefined): string | null {
  if (!d || typeof d !== "object") return null;
  const rec = d as Record<string, unknown>;
  const a = rec.photoURL;
  const b = rec.photoUrl;
  const s =
    (typeof a === "string" && a.trim() ? a : typeof b === "string" && b.trim() ? b : "").trim();
  return s || null;
}

/**
 * Read `users/{uid}` for attribution: `getDoc` first (local persistence sees pending sync writes),
 * then server if missing, then cache again (offline).
 */
async function readUserDocForAddedBy(ref: DocumentReference): Promise<DocumentSnapshot | null> {
  try {
    const local = await getDoc(ref);
    if (local.exists()) return local;
  } catch {
    /* fall through */
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 200 * attempt));
    try {
      const snap = await getDocFromServer(ref);
      if (snap.exists()) return snap;
      break;
    } catch {
      /* retry */
    }
  }
  try {
    const snap = await getDoc(ref);
    return snap.exists() ? snap : null;
  } catch {
    return null;
  }
}

/** One read per distinct `addedByUid` (parallel). */
async function bulkGetAddedByUserFieldsForUids(uids: string[]): Promise<Map<string, AddedByUserFields>> {
  const uniq = [...new Set(uids.filter((id) => typeof id === "string" && id.length > 0))];
  const map = new Map<string, AddedByUserFields>();
  await Promise.all(
    uniq.map(async (id) => {
      try {
        const ref = doc(db, "users", id);
        const snap = await readUserDocForAddedBy(ref);
        if (!snap) return;
        const d = snap.data();
        const n = displayNameFromUserDoc(d);
        const p = photoUrlFromUserDoc(d);
        if (n || p) map.set(id, { displayName: n, photoURL: p });
      } catch {
        /* rules / offline */
      }
    })
  );
  return map;
}

async function mergeAddedByDisplayNamesFromUsers(items: WatchlistItem[]): Promise<WatchlistItem[]> {
  const uids = items
    .map((m) => m.addedByUid)
    .filter((x): x is string => typeof x === "string" && x.length > 0);
  if (uids.length === 0) return items;
  const nameMap = await bulkGetAddedByUserFieldsForUids(uids);
  return items.map((m) => {
    if (!m.addedByUid) return m;
    const u = nameMap.get(m.addedByUid);
    const next: WatchlistItem = { ...m };
    if (u) {
      if (u.displayName) next.addedByDisplayName = u.displayName;
      if (u.photoURL) next.addedByPhotoUrl = u.photoURL;
    }
    /** Denormalized list row when `users/{uid}` read is empty or missing fields. */
    if (!next.addedByDisplayName?.trim() && m.addedByDisplayName?.trim()) {
      next.addedByDisplayName = m.addedByDisplayName.trim();
    }
    if (!next.addedByPhotoUrl?.trim() && m.addedByPhotoUrl?.trim()) {
      next.addedByPhotoUrl = m.addedByPhotoUrl.trim();
    }
    return next;
  });
}

/** Lightweight read for shared-list UI (avatar) without resolving default personal list. */
async function getUserPublicPhotoUrl(uid: string): Promise<string | null> {
  try {
    const ref = doc(db, "users", uid);
    const snap = await readUserDocForAddedBy(ref);
    if (!snap) return null;
    return photoUrlFromUserDoc(snap.data());
  } catch {
    return null;
  }
}

async function setUserCountry(uid: string, countryCode: string, countryName: string | null | undefined): Promise<void> {
  const ref = doc(db, "users", uid);
  await setDoc(ref, { country: countryCode, countryName: countryName || countryCode }, { merge: true });
}

async function setStatus(uid: string, key: string, status: string): Promise<void> {
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

async function removeTitle(uid: string, key: string): Promise<void> {
  const listId = await resolveDefaultPersonalListId(uid);
  if (!listId) return;
  const ref = doc(db, "users", uid, "personalLists", listId);
  const snap = await getDoc(ref);
  const data: DocumentData = snap.exists() ? snap.data() : {};
  const rawItems = Array.isArray(data.items) ? (data.items as FirestoreListRow[]) : [];
  const items = rawItems.filter((m) => movieKey(m) !== key);
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

async function createSharedList(uid: string, name: string): Promise<string> {
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

async function getSharedList(listId: string): Promise<SharedList | null> {
  const ref = doc(db, "sharedLists", listId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  return sharedListFromFirestoreDoc(listId, snap.data());
}

async function getSharedListsForUser(uid: string): Promise<SharedList[]> {
  const startedAt = Date.now();
  const q = query(
    collection(db, "sharedLists"),
    where("members", "array-contains", uid)
  );
  const snap = await getDocs(q);
  const lists = snap.docs.map((d) => sharedListFromFirestoreDoc(d.id, d.data()));
  void logEvent({
    type: "firestore.read",
    collection: "sharedLists",
    operation: "list",
    documentCount: lists.length,
    durationMs: Date.now() - startedAt,
    uid,
  }).catch(() => {});
  return lists;
}

async function getSharedListMovies(listId: string): Promise<WatchlistItem[]> {
  const startedAt = Date.now();
  const data = await getSharedList(listId);
  if (!data) {
    void logEvent({
      type: "firestore.read",
      collection: "sharedLists",
      documentCount: 0,
      durationMs: Date.now() - startedAt,
    }).catch(() => {});
    return [];
  }
  const items = Array.isArray(data.items) ? data.items : [];
  const watchedSet = new Set((data.watched ?? []).map((k) => String(k)));
  const maybeLaterSet = new Set((data.maybeLater ?? []).map((k) => String(k)));
  const archiveSet = new Set((data.archive ?? []).map((k) => String(k)));
  const hydrated = await hydrateListItemsFromRegistry(items, watchedSet, maybeLaterSet, archiveSet);
  const movies = await mergeAddedByDisplayNamesFromUsers(hydrated);
  void logEvent({
    type: "firestore.read",
    collection: "sharedLists",
    documentCount: movies.length,
    durationMs: Date.now() - startedAt,
  }).catch(() => {});
  return movies;
}

async function setSharedListStatus(listId: string, key: string, status: string): Promise<void> {
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

async function removeFromSharedList(listId: string, key: string): Promise<void> {
  const ref = doc(db, "sharedLists", listId);
  const snap = await getDoc(ref);
  const data: DocumentData = snap.exists() ? snap.data() : {};
  const rawItems = Array.isArray(data.items) ? (data.items as FirestoreListRow[]) : [];
  const items = rawItems.filter((m) => movieKey(m) !== key);
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

async function addToSharedList(listId: string, movie: WatchlistItem, addedByUid: string): Promise<void> {
  const ref = doc(db, "sharedLists", listId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error("Shared list not found");
  const data = snap.data();
  const items: FirestoreListRow[] = Array.isArray(data.items) ? [...(data.items as FirestoreListRow[])] : [];
  const key = movieKey(movie);
  const exists = items.some((m) => movieKey(m) === key);
  if (exists) return;
  const base = rowToStore(movie);
  const cur = auth.currentUser;
  const row: FirestoreListRow = { ...base, addedByUid };
  if (cur?.uid === addedByUid) {
    const dn = cur.displayName?.trim() || (cur.email ? cur.email.split("@")[0] : "") || "";
    const photo = cur.photoURL?.trim() || "";
    if (dn) row.addedByDisplayName = dn;
    if (photo) row.addedByPhotoUrl = photo;
  } else {
    if (movie.addedByDisplayName?.trim()) row.addedByDisplayName = movie.addedByDisplayName.trim();
    if (movie.addedByPhotoUrl?.trim()) row.addedByPhotoUrl = movie.addedByPhotoUrl.trim();
  }
  items.push(row);
  const watched = new Set((Array.isArray(data.watched) ? data.watched : []).map((k) => String(k)));
  const maybeLater = new Set((Array.isArray(data.maybeLater) ? data.maybeLater : []).map((k) => String(k)));
  const archive = new Set((Array.isArray(data.archive) ? data.archive : []).map((k) => String(k)));
  const s = movie.status || "to-watch";
  if (s === "watched") watched.add(key);
  else if (s === "maybe-later") maybeLater.add(key);
  else if (s === "archive") archive.add(key);
  await setDoc(ref, { items, watched: [...watched], maybeLater: [...maybeLater], archive: [...archive] }, { merge: true });
  // Keep `users/{uid}` in sync for other features; list rows carry denormalized attribution.
  if (cur && cur.uid === addedByUid) {
    const label =
      cur.displayName?.trim() || (cur.email ? cur.email.split("@")[0] : "") || "";
    void syncUserDisplayNameToFirestore(addedByUid, label || null, cur.photoURL ?? null);
  }
}

async function addToPersonalList(uid: string, listId: string, movie: WatchlistItem): Promise<void> {
  const key = movieKey(movie);
  const s = movie.status || "to-watch";
  if (listId === "personal") {
    const resolved = await resolveDefaultPersonalListId(uid);
    if (!resolved) throw new Error("No personal list. Open the app and name your list first.");
    const ref = doc(db, "users", uid, "personalLists", resolved);
    const snap = await getDoc(ref);
    const data: DocumentData = snap.exists() ? snap.data() : {};
    const items: FirestoreListRow[] = Array.isArray(data.items) ? [...(data.items as FirestoreListRow[])] : [];
    if (items.some((m) => movieKey(m) === key)) return;
    items.push(rowToStore(movie));
    const watched = new Set((Array.isArray(data.watched) ? data.watched : []).map((k) => String(k)));
    const maybeLater = new Set((Array.isArray(data.maybeLater) ? data.maybeLater : []).map((k) => String(k)));
    const archive = new Set((Array.isArray(data.archive) ? data.archive : []).map((k) => String(k)));
    if (s === "watched") watched.add(key);
    else if (s === "maybe-later") maybeLater.add(key);
    else if (s === "archive") archive.add(key);
    await setDoc(ref, { items, watched: [...watched], maybeLater: [...maybeLater], archive: [...archive] }, { merge: true });
  } else {
    const ref = doc(db, "users", uid, "personalLists", listId);
    const snap = await getDoc(ref);
    if (!snap.exists()) throw new Error("Personal list not found");
    const data = snap.data();
    const items: FirestoreListRow[] = Array.isArray(data.items) ? [...(data.items as FirestoreListRow[])] : [];
    if (items.some((m) => movieKey(m) === key)) return;
    items.push(rowToStore(movie));
    const watched = new Set((Array.isArray(data.watched) ? data.watched : []).map((k) => String(k)));
    const maybeLater = new Set((Array.isArray(data.maybeLater) ? data.maybeLater : []).map((k) => String(k)));
    const archive = new Set((Array.isArray(data.archive) ? data.archive : []).map((k) => String(k)));
    if (s === "watched") watched.add(key);
    else if (s === "maybe-later") maybeLater.add(key);
    else if (s === "archive") archive.add(key);
    await setDoc(ref, { items, watched: [...watched], maybeLater: [...maybeLater], archive: [...archive] }, { merge: true });
  }
}

/**
 * Create a new personal list (subcollection). Requires a non-empty trimmed name.
 */
async function createPersonalList(uid: string, name: string): Promise<string> {
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
async function getPersonalLists(uid: string): Promise<PersonalList[]> {
  const startedAt = Date.now();
  try {
    await migrateLegacyPersonalListIfNeeded(uid);
    const userSnap = await getDoc(doc(db, "users", uid));
    const data: DocumentData = userSnap.exists() ? userSnap.data() : {};
    const defaultId = typeof data.defaultPersonalListId === "string" ? data.defaultPersonalListId.trim() : "";
    const lists: PersonalList[] = [];
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
    void logEvent({
      type: "firestore.read",
      collection: "personalLists",
      operation: "list",
      documentCount: lists.length,
      durationMs: Date.now() - startedAt,
      uid,
    }).catch(() => {});
    return lists;
  } catch (e: unknown) {
    console.warn("getPersonalLists failed:", e);
    void logEvent({
      type: "firestore.read",
      collection: "personalLists",
      operation: "list",
      documentCount: 1,
      durationMs: Date.now() - startedAt,
      uid,
    }).catch(() => {});
    return [{ id: "personal", name: "", count: 0, isDefault: true }];
  }
}

/**
 * Get movies for a personal list.
 */
async function getPersonalListMovies(uid: string, listId: string): Promise<WatchlistItem[]> {
  const startedAt = Date.now();
  let targetId = listId;
  if (listId === "personal") {
    targetId = await resolveDefaultPersonalListId(uid);
    if (!targetId) {
      void logEvent({
        type: "firestore.read",
        collection: "personalLists",
        documentCount: 0,
        durationMs: Date.now() - startedAt,
        uid,
      }).catch(() => {});
      return [];
    }
  }
  try {
    const ref = doc(db, "users", uid, "personalLists", targetId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return [];
    const data = snap.data();
    // personalLists `items` are list rows (registry refs or legacy embeds), same union as hydrate input.
    const items = (Array.isArray(data.items) ? data.items : []) as ListRowForHydrate[];
    const watchedSet = new Set((Array.isArray(data.watched) ? data.watched : []).map((k) => String(k)));
    const maybeLaterSet = new Set((Array.isArray(data.maybeLater) ? data.maybeLater : []).map((k) => String(k)));
    const archiveSet = new Set((Array.isArray(data.archive) ? data.archive : []).map((k) => String(k)));
    const movies = await hydrateListItemsFromRegistry(items, watchedSet, maybeLaterSet, archiveSet);
    void logEvent({
      type: "firestore.read",
      collection: "personalLists",
      documentCount: movies.length,
      durationMs: Date.now() - startedAt,
      uid,
    }).catch(() => {});
    return movies;
  } catch (e: unknown) {
    console.warn("getPersonalListMovies failed:", e);
    void logEvent({
      type: "firestore.read",
      collection: "personalLists",
      documentCount: 0,
      durationMs: Date.now() - startedAt,
      uid,
    }).catch(() => {});
    return [];
  }
}

async function setPersonalListStatus(uid: string, listId: string, key: string, status: string): Promise<void> {
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

async function removeFromPersonalList(uid: string, listId: string, key: string): Promise<void> {
  if (listId === "personal") {
    await removeTitle(uid, key);
    return;
  }
  const ref = doc(db, "users", uid, "personalLists", listId);
  const snap = await getDoc(ref);
  const data: DocumentData = snap.exists() ? snap.data() : {};
  const rawItems = Array.isArray(data.items) ? (data.items as FirestoreListRow[]) : [];
  const items = rawItems.filter((m) => movieKey(m) !== key);
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

async function renamePersonalList(uid: string, listId: string, newName: string): Promise<void> {
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

async function deletePersonalList(uid: string, listId: string): Promise<void> {
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

async function renameSharedList(listId: string, newName: string): Promise<void> {
  const name = String(newName || "").trim();
  if (!name) throw new Error("Name cannot be empty");
  await setDoc(doc(db, "sharedLists", listId), { name }, { merge: true });
}

async function deleteSharedList(listId: string): Promise<void> {
  await deleteDoc(doc(db, "sharedLists", listId));
}

/**
 * Leave a shared list. Removes the user from the list's members.
 */
async function leaveSharedList(uid: string, listId: string): Promise<void> {
  const listData = await getSharedList(listId);
  if (!listData) throw new Error("Shared list not found");
  const members = Array.isArray(listData.members) ? listData.members : [];
  if (!members.includes(uid)) throw new Error("You are not a member of this shared list");
  const ref = doc(db, "sharedLists", listId);
  await setDoc(ref, { members: arrayRemove(uid) }, { merge: true });
}

function listItemToUpcomingPair(
  m: WatchlistItem | FirestoreListRow | null | undefined
): { tmdbId: number; media: "tv" | "movie" } | null {
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
 */
async function fetchUpcomingAlertsForItems(
  items: readonly WatchlistItem[] | WatchlistItem[] | undefined | null
): Promise<UpcomingAlert[]> {
  const startedAt = Date.now();
  const pairKeys = new Set<string>();
  const tmdbIds = new Set<number>();
  for (const m of items || []) {
    const p = listItemToUpcomingPair(m);
    if (!p) continue;
    pairKeys.add(`${p.tmdbId}|${p.media}`);
    tmdbIds.add(p.tmdbId);
  }
  if (tmdbIds.size === 0) {
    void logEvent({
      type: "firestore.read",
      collection: "upcomingAlerts",
      documentCount: 0,
      durationMs: Date.now() - startedAt,
    }).catch(() => {});
    return [];
  }

  const ids = [...tmdbIds];
  const CHUNK = 10;
  const byId = new Map<string, DocumentData & { id: string }>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const q = query(collection(db, "upcomingAlerts"), where("catalogTmdbId", "in", chunk));
    const snap = await getDocs(q);
    snap.forEach((d) => {
      byId.set(d.id, { id: d.id, ...d.data() });
    });
  }

  const today = new Date().toISOString().slice(0, 10);
  const out: UpcomingAlert[] = [];
  for (const a of byId.values()) {
    const c = a.catalogTmdbId;
    const med = a.media;
    if (c == null || !med) continue;
    if (!pairKeys.has(`${c}|${med}`)) continue;
    if (a.expiresAt && String(a.expiresAt) < today) continue;
    out.push(upcomingAlertFromMergedDoc(a));
  }
  void logEvent({
    type: "firestore.read",
    collection: "upcomingAlerts",
    documentCount: out.length,
    durationMs: Date.now() - startedAt,
  }).catch(() => {});
  return out;
}

/**
 * Persist dismissal fingerprint on users/{uid}.upcomingDismissals.{fingerprint}
 */
async function dismissUpcomingAlert(uid: string | null | undefined, fingerprint: string | null | undefined): Promise<void> {
  if (!uid || !fingerprint) return;
  const day = new Date().toISOString().slice(0, 10);
  const ref = doc(db, "users", uid);
  await setDoc(ref, { upcomingDismissals: { [String(fingerprint)]: day } }, { merge: true });
}

/**
 * Real Firestore id under users/{uid}/personalLists/{id} for bookmarklet cookies.
 * Pass listId "personal" for the default list, or an existing subcollection id.
 */
async function getBookmarkletPersonalListFirestoreId(
  uid: string,
  listIdOrAlias: string | null | undefined
): Promise<string | null> {
  if (listIdOrAlias === "personal") {
    return (await resolveDefaultPersonalListId(uid)) || null;
  }
  return listIdOrAlias || null;
}

type WhatsAppListType = "personal" | "shared";

function phoneIndexDocIdClient(e164Phone: string): string {
  return String(e164Phone || "").replace(/\D/g, "");
}

async function getUserPhoneNumbers(uid: string): Promise<string[]> {
  const snap = await getDoc(doc(db, "users", uid));
  const raw = snap.exists() ? snap.data().phoneNumbers : undefined;
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => String(x).replace(/\D/g, "")).filter(Boolean);
}

async function addUserPhoneNumber(
  uid: string,
  e164Phone: string,
  defaultAddListId: string,
  defaultListType: WhatsAppListType
): Promise<void> {
  const pid = phoneIndexDocIdClient(e164Phone);
  const listId = defaultAddListId.trim();
  if (!pid || !listId) throw new Error("Invalid phone or list");
  const t: WhatsAppListType = defaultListType === "shared" ? "shared" : "personal";
  await setDoc(
    doc(db, "phoneIndex", pid),
    {
      uid,
      defaultAddListId: listId,
      defaultListType: t,
      updatedAt: new Date().toISOString(),
    },
    { merge: true }
  );
  await setDoc(doc(db, "users", uid), { phoneNumbers: arrayUnion(pid) }, { merge: true });
}

async function removeUserPhoneNumber(uid: string, e164Phone: string): Promise<void> {
  const pid = phoneIndexDocIdClient(e164Phone);
  if (!pid) return;
  await deleteDoc(doc(db, "phoneIndex", pid));
  await setDoc(doc(db, "users", uid), { phoneNumbers: arrayRemove(pid) }, { merge: true });
}

async function getUserDefaultWhatsAppList(
  uid: string
): Promise<{ defaultAddListId: string; defaultListType: WhatsAppListType } | null> {
  const nums = await getUserPhoneNumbers(uid);
  if (nums.length === 0) return null;
  const first = nums[0];
  if (first === undefined) return null;
  const snap = await getDoc(doc(db, "phoneIndex", first));
  if (!snap.exists()) return null;
  const d = snap.data();
  const defaultAddListId = typeof d.defaultAddListId === "string" ? d.defaultAddListId.trim() : "";
  const defaultListType: WhatsAppListType = d.defaultListType === "shared" ? "shared" : "personal";
  if (!defaultAddListId) return null;
  return { defaultAddListId, defaultListType };
}

async function setUserDefaultWhatsAppList(
  uid: string,
  defaultAddListId: string,
  defaultListType: WhatsAppListType
): Promise<void> {
  const nums = await getUserPhoneNumbers(uid);
  if (nums.length === 0) return;
  const t: WhatsAppListType = defaultListType === "shared" ? "shared" : "personal";
  const trimmed = defaultAddListId.trim();
  if (!trimmed) throw new Error("Invalid list");
  const batch = writeBatch(db);
  for (const p of nums) {
    batch.set(
      doc(db, "phoneIndex", p),
      {
        uid,
        defaultAddListId: trimmed,
        defaultListType: t,
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
  }
  await batch.commit();
}

async function setWhatsAppDefaultListForPhone(
  uid: string,
  phoneDigits: string,
  defaultAddListId: string,
  defaultListType: WhatsAppListType
): Promise<void> {
  const pid = phoneIndexDocIdClient(phoneDigits);
  const trimmed = defaultAddListId.trim();
  if (!pid || !trimmed) throw new Error("Invalid phone or list");
  const snap = await getDoc(doc(db, "phoneIndex", pid));
  if (!snap.exists()) throw new Error("Phone not linked");
  const owner = snap.data().uid;
  if (typeof owner !== "string" || owner !== uid) throw new Error("Not your number");
  const t: WhatsAppListType = defaultListType === "shared" ? "shared" : "personal";
  await setDoc(
    doc(db, "phoneIndex", pid),
    {
      uid,
      defaultAddListId: trimmed,
      defaultListType: t,
      updatedAt: new Date().toISOString(),
    },
    { merge: true }
  );
}

async function resolveWhatsAppListPayload(
  uid: string,
  choice: string
): Promise<{ defaultAddListId: string; defaultListType: WhatsAppListType }> {
  if (choice.startsWith("s:")) {
    const id = choice.slice(2).trim();
    if (!id) throw new Error("Pick a shared list.");
    return { defaultAddListId: id, defaultListType: "shared" };
  }
  if (choice.startsWith("p:")) {
    const listKey = choice.slice(2) || "personal";
    const fid = await getBookmarkletPersonalListFirestoreId(uid, listKey);
    if (!fid) throw new Error("Pick a valid personal list.");
    return { defaultAddListId: fid, defaultListType: "personal" };
  }
  throw new Error("Pick a list.");
}

async function whatsappListChoiceKeyForTargets(
  uid: string,
  defaultAddListId: string,
  defaultListType: WhatsAppListType,
  personalLists: PersonalList[],
  sharedLists: SharedList[]
): Promise<string> {
  if (defaultListType === "shared") {
    const hit = sharedLists.find((l) => l.id === defaultAddListId);
    return hit ? `s:${hit.id}` : `s:${defaultAddListId}`;
  }
  for (const pl of personalLists) {
    const fid = await getBookmarkletPersonalListFirestoreId(uid, pl.id);
    if (fid === defaultAddListId) return `p:${pl.id}`;
  }
  return "p:personal";
}

async function getPhoneIndexDefaultsForNumber(
  uid: string,
  phoneDigits: string
): Promise<{ defaultAddListId: string; defaultListType: WhatsAppListType } | null> {
  const pid = phoneIndexDocIdClient(phoneDigits);
  if (!pid) return null;
  const snap = await getDoc(doc(db, "phoneIndex", pid));
  if (!snap.exists()) return null;
  const d = snap.data();
  if (typeof d.uid !== "string" || d.uid !== uid) return null;
  const defaultAddListId = typeof d.defaultAddListId === "string" ? d.defaultAddListId.trim() : "";
  const defaultListType: WhatsAppListType = d.defaultListType === "shared" ? "shared" : "personal";
  if (!defaultAddListId) return null;
  return { defaultAddListId, defaultListType };
}

/** Document `meta/usageStats` — serverless read-quota guard (Admin client read only). */
export type FirestoreUsageStats = {
  readsToday: number;
  readsThisHour: number;
  lastResetDate: string;
  lastResetHour: number;
  updatedAt: string;
};

function numField(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function strField(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Read Firestore read-quota counters (admin-only per `firestore.rules`).
 * @returns `null` if the document does not exist yet.
 */
async function getFirestoreUsageStats(): Promise<FirestoreUsageStats | null> {
  const ref = doc(db, "meta", "usageStats");
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  const d = snap.data() as Record<string, unknown>;
  return {
    readsToday: numField(d.readsToday),
    readsThisHour: numField(d.readsThisHour),
    lastResetDate: strField(d.lastResetDate),
    lastResetHour: numField(d.lastResetHour),
    updatedAt: strField(d.updatedAt),
  };
}

async function getJobConfigState(): Promise<JobConfigState> {
  try {
    const res = await fetch("/api/admin-job-config", {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    const raw = await res.text();
    let data: {
      ok?: boolean;
      error?: string;
      config?: Partial<JobConfigState>;
    } = {};
    try {
      data = raw ? (JSON.parse(raw) as typeof data) : {};
    } catch {
      // non-json function/proxy error
    }
    if (!res.ok || data.ok === false || !data.config) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return {
      checkUpcomingEnabled: data.config.checkUpcomingEnabled !== false,
      lastRunAt: data.config.lastRunAt ?? null,
      lastRunStatus: data.config.lastRunStatus ?? null,
      lastRunMessage: data.config.lastRunMessage ?? null,
      lastRunResult: (data.config.lastRunResult as Record<string, unknown> | null | undefined) ?? null,
    };
  } catch (err: unknown) {
    if (err instanceof Error) throw err;
    throw new Error(String(err || "Failed to load job config."));
  }
}

async function setCheckUpcomingEnabledState(enabled: boolean): Promise<JobConfigState> {
  try {
    const res = await fetch("/api/admin-job-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ checkUpcomingEnabled: enabled }),
    });
    const raw = await res.text();
    let data: {
      ok?: boolean;
      error?: string;
      config?: Partial<JobConfigState>;
    } = {};
    try {
      data = raw ? (JSON.parse(raw) as typeof data) : {};
    } catch {
      // non-json function/proxy error
    }
    if (!res.ok || data.ok === false || !data.config) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return {
      checkUpcomingEnabled: data.config.checkUpcomingEnabled !== false,
      lastRunAt: data.config.lastRunAt ?? null,
      lastRunStatus: data.config.lastRunStatus ?? null,
      lastRunMessage: data.config.lastRunMessage ?? null,
      lastRunResult: (data.config.lastRunResult as Record<string, unknown> | null | undefined) ?? null,
    };
  } catch (err: unknown) {
    if (err instanceof Error) throw err;
    throw new Error(String(err || "Failed to update job config."));
  }
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
  syncUserDisplayNameToFirestore,
  getUserPublicPhotoUrl,
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
  getJobConfigState,
  getFirestoreUsageStats,
  setCheckUpcomingEnabledState,
  getUserPhoneNumbers,
  addUserPhoneNumber,
  removeUserPhoneNumber,
  getUserDefaultWhatsAppList,
  setUserDefaultWhatsAppList,
  setWhatsAppDefaultListForPhone,
  resolveWhatsAppListPayload,
  whatsappListChoiceKeyForTargets,
  getPhoneIndexDefaultsForNumber,
  normalizeUserEmailKey,
  checkUserAllowed,
  getIdTokenForApi,
};

export type { WhatsAppListType };
