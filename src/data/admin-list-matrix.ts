import {
  collection,
  doc,
  documentId,
  getDoc,
  getDocs,
  getFirestore,
  limit,
  orderBy,
  query,
  startAfter,
} from "firebase/firestore";
import type { DocumentData, QueryDocumentSnapshot } from "firebase/firestore";
import { addTitleToList, removeTitleFromList, setTitleStatus } from "./titles.js";
import {
  auth,
  getDefaultPersonalListId,
  getPersonalLists,
  getSharedListsForUser,
  listKey,
} from "../firebase.js";
import {
  matrixChoiceToStatusKey,
  membershipToMatrixChoice,
  type MatrixUiChoice,
} from "../lib/admin-list-matrix.js";
import type { FirestoreListRow, ListMode, WatchlistItem } from "../types/index.js";

const CATALOG_PAGE_SIZE = 100;

export type MatrixListColumnSnapshot = {
  columnKey: string;
  name: string;
  kind: "personal" | "shared";
  listMode: ListMode;
  itemKeys: Set<string>;
  watched: Set<string>;
  maybeLater: Set<string>;
  archive: Set<string>;
};

export type CatalogMatrixRow = {
  id: string;
  title: string;
  year: number | null;
  yearLabel: string;
};

export type CatalogPageResult = {
  rows: CatalogMatrixRow[];
  /** Last document in this page; pass to next page fetch. */
  lastDoc: QueryDocumentSnapshot | null;
  hasMore: boolean;
};

function stringSet(arr: unknown): Set<string> {
  if (!Array.isArray(arr)) return new Set();
  return new Set(arr.map((k) => String(k)));
}

function parseListDocArrays(
  data: DocumentData,
  itemsRaw: unknown
): Omit<MatrixListColumnSnapshot, "columnKey" | "name" | "kind" | "listMode"> {
  const items = (Array.isArray(itemsRaw) ? itemsRaw : []) as FirestoreListRow[];
  const itemKeys = new Set(items.map((m) => listKey(m)));
  return {
    itemKeys,
    watched: stringSet(data.watched),
    maybeLater: stringSet(data.maybeLater),
    archive: stringSet(data.archive),
  };
}

function enrichItemForSharedAdd(
  uid: string,
  col: MatrixListColumnSnapshot,
  item: WatchlistItem
): WatchlistItem {
  if (col.kind !== "shared") return item;
  const u = auth.currentUser;
  if (!u || u.uid !== uid) return { ...item, addedByUid: uid };
  const dn = u.displayName?.trim() || (u.email ? u.email.split("@")[0] : "") || "";
  const photo = u.photoURL?.trim() || "";
  return {
    ...item,
    addedByUid: uid,
    ...(dn ? { addedByDisplayName: dn } : {}),
    ...(photo ? { addedByPhotoUrl: photo } : {}),
  };
}

/** Minimal item for adds from paginated catalog rows (`addTo*` only persists `registryId` + `addedAt`). */
export function watchlistItemFromCatalogRow(row: CatalogMatrixRow): WatchlistItem {
  return {
    registryId: row.id,
    title: row.title,
    year: row.year,
    type: "movie",
    genre: "",
    thumb: null,
    youtubeId: null,
    imdbId: null,
    tmdbId: null,
    services: [],
    servicesByRegion: null,
    status: "to-watch",
  };
}

export function watchlistItemFromRegistryDoc(
  registryId: string,
  data: DocumentData
): WatchlistItem {
  const title =
    typeof data.title === "string" && data.title.trim() ? data.title.trim() : registryId;
  let year: number | null = null;
  if (typeof data.year === "number" && Number.isFinite(data.year)) year = data.year;
  else if (typeof data.year === "string" && data.year.trim() && !Number.isNaN(Number(data.year)))
    year = Number(data.year);
  const type =
    data.type === "show" || data.tmdbMedia === "tv" || data.type === "tv" ? "show" : "movie";
  return {
    registryId,
    title,
    year,
    type,
    genre: typeof data.genre === "string" ? data.genre : "",
    thumb: typeof data.thumb === "string" ? data.thumb : null,
    youtubeId: typeof data.youtubeId === "string" ? data.youtubeId : null,
    imdbId: typeof data.imdbId === "string" ? data.imdbId : null,
    tmdbId: typeof data.tmdbId === "number" ? data.tmdbId : null,
    services: Array.isArray(data.services)
      ? data.services.filter((x): x is string => typeof x === "string")
      : [],
    servicesByRegion: null,
    status: "to-watch",
  };
}

async function ensureWatchlistItem(
  registryId: string,
  cache: Map<string, WatchlistItem>
): Promise<WatchlistItem> {
  const hit = cache.get(registryId);
  if (hit) return hit;
  const db = getFirestore();
  const snap = await getDoc(doc(db, "titleRegistry", registryId));
  if (!snap.exists()) throw new Error(`Catalog document not found: ${registryId}`);
  const item = watchlistItemFromRegistryDoc(registryId, snap.data());
  cache.set(registryId, item);
  return item;
}

/** Load personal + shared list membership arrays for the matrix (no titleRegistry hydration). */
export async function loadAdminListMatrixColumns(uid: string): Promise<MatrixListColumnSnapshot[]> {
  const db = getFirestore();
  const out: MatrixListColumnSnapshot[] = [];
  const personalMeta = await getPersonalLists(uid);
  const defaultFsId = await getDefaultPersonalListId(uid);

  for (const pl of personalMeta) {
    const firestoreId = pl.id === "personal" ? defaultFsId : pl.id;
    if (!firestoreId) continue;
    const snap = await getDoc(doc(db, "users", uid, "personalLists", firestoreId));
    if (!snap.exists()) continue;
    const data = snap.data();
    const arrays = parseListDocArrays(data, data.items);
    const columnKey = pl.id === "personal" ? "p:personal" : `p:${pl.id}`;
    const listMode: ListMode =
      pl.id === "personal" ? "personal" : { type: "personal", listId: pl.id, name: pl.name };
    out.push({
      columnKey,
      name: pl.name || (pl.id === "personal" ? "Default list" : "Personal list"),
      kind: "personal",
      listMode,
      ...arrays,
    });
  }

  const shared = await getSharedListsForUser(uid);
  for (const sl of shared) {
    const snap = await getDoc(doc(db, "sharedLists", sl.id));
    if (!snap.exists()) continue;
    const data = snap.data();
    const arrays = parseListDocArrays(data, data.items);
    out.push({
      columnKey: `s:${sl.id}`,
      name: sl.name || "Shared list",
      kind: "shared",
      listMode: { type: "shared", listId: sl.id, name: sl.name },
      ...arrays,
    });
  }

  return out;
}

function parseYear(y: unknown): { year: number | null; yearLabel: string } {
  if (y == null || y === "") return { year: null, yearLabel: "—" };
  if (typeof y === "number" && Number.isFinite(y)) return { year: y, yearLabel: String(y) };
  if (typeof y === "string" && y.trim() && !Number.isNaN(Number(y))) {
    const n = Number(y);
    return { year: n, yearLabel: String(n) };
  }
  return { year: null, yearLabel: String(y) };
}

export async function loadTitleRegistryPage(
  startAfterDoc: QueryDocumentSnapshot | null
): Promise<CatalogPageResult> {
  const db = getFirestore();
  const coll = collection(db, "titleRegistry");
  const base = query(coll, orderBy(documentId()), limit(CATALOG_PAGE_SIZE));
  const q = startAfterDoc
    ? query(coll, orderBy(documentId()), startAfter(startAfterDoc), limit(CATALOG_PAGE_SIZE))
    : base;
  const snap = await getDocs(q);
  const rows: CatalogMatrixRow[] = snap.docs.map((d) => {
    const x = d.data();
    const { year, yearLabel } = parseYear(x.year);
    return {
      id: d.id,
      title: typeof x.title === "string" && x.title.trim() ? x.title.trim() : d.id,
      year,
      yearLabel,
    };
  });
  const lastDoc = snap.docs.length > 0 ? snap.docs[snap.docs.length - 1]! : null;
  const hasMore = snap.docs.length === CATALOG_PAGE_SIZE;
  return { rows, lastDoc, hasMore };
}

export function matrixCellChoice(
  registryId: string,
  col: MatrixListColumnSnapshot,
  override: MatrixUiChoice | undefined
): MatrixUiChoice {
  if (override !== undefined) return override;
  return membershipToMatrixChoice(
    registryId,
    col.itemKeys,
    col.watched,
    col.maybeLater,
    col.archive
  );
}

async function applyOneCellChange(
  uid: string,
  col: MatrixListColumnSnapshot,
  registryId: string,
  from: MatrixUiChoice,
  to: MatrixUiChoice,
  item: WatchlistItem | null
): Promise<void> {
  if (from === to) return;
  const { listMode } = col;

  if (to === "absent") {
    await removeTitleFromList(uid, listMode, registryId);
    return;
  }

  const statusKey = matrixChoiceToStatusKey(to);

  if (from === "absent") {
    if (!item) throw new Error(`Cannot add ${registryId} without catalog metadata`);
    const addItem = enrichItemForSharedAdd(uid, col, { ...item, registryId, status: statusKey });
    await addTitleToList(uid, listMode, addItem);
    return;
  }

  await setTitleStatus(uid, listMode, registryId, statusKey);
}

export type MatrixSubmitDiff = {
  registryId: string;
  columnKey: string;
  from: MatrixUiChoice;
  to: MatrixUiChoice;
};

/** Build diffs from user overrides vs current server membership (re-read columns not needed — use snapshot from load). */
export function buildMatrixSubmitDiffs(
  columns: readonly MatrixListColumnSnapshot[],
  overrides: ReadonlyMap<string, ReadonlyMap<string, MatrixUiChoice>>
): MatrixSubmitDiff[] {
  const colByKey = new Map(columns.map((c) => [c.columnKey, c] as const));
  const out: MatrixSubmitDiff[] = [];
  for (const [registryId, colMap] of overrides) {
    for (const [columnKey, to] of colMap) {
      const col = colByKey.get(columnKey);
      if (!col) continue;
      const from = membershipToMatrixChoice(
        registryId,
        col.itemKeys,
        col.watched,
        col.maybeLater,
        col.archive
      );
      if (from !== to) {
        out.push({ registryId, columnKey, from, to });
      }
    }
  }
  return out;
}

/** Apply Firestore updates for each diff (sequential). */
export async function applyAdminListMatrixDiffs(
  uid: string,
  columns: readonly MatrixListColumnSnapshot[],
  diffs: readonly MatrixSubmitDiff[],
  itemCache: Map<string, WatchlistItem>
): Promise<void> {
  const colByKey = new Map(columns.map((c) => [c.columnKey, c] as const));
  for (const d of diffs) {
    const col = colByKey.get(d.columnKey);
    if (!col) continue;
    const item = d.to === "absent" ? null : await ensureWatchlistItem(d.registryId, itemCache);
    await applyOneCellChange(uid, col, d.registryId, d.from, d.to, item);
  }
}
