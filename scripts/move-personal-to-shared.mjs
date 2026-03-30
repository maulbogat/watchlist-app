#!/usr/bin/env node
/**
 * Move all items from the user's default personal list into a shared list (default name: "Our list").
 * - Dedupes by registry id (list key).
 * - Upserts titleRegistry for legacy embedded rows (no registryId).
 * - Rows already on the shared list keep their existing shared watch/maybe-later state.
 * - Rows only on personal get personal watch state (watched > maybe-later > to-watch).
 * - Orphan keys in personal watched/maybeLater (not in items) are added as { registryId }.
 *
 * After a successful --write run, the default personal list's items + status arrays are cleared
 * (list doc and name remain).
 *
 * Usage:
 *   node -r dotenv/config scripts/move-personal-to-shared.mjs --dry-run <uid>
 *   node -r dotenv/config scripts/move-personal-to-shared.mjs --write <uid> ["Our list"]
 *
 * uid can be omitted if USER_UID is set.
 */
import "dotenv/config";
import { FieldValue } from "firebase-admin/firestore";
import { getDb } from "./lib/admin-init.mjs";
import { listKey, registryDocIdFromItem, payloadForRegistry } from "../lib/registry-id.js";

function parseArgs() {
  const argv = process.argv.slice(2);
  const write = argv.includes("--write");
  const positional = argv.filter((a) => !a.startsWith("--"));
  const uid = positional[0] || process.env.USER_UID;
  const sharedName = positional[1] || "Our list";
  return { write, uid, sharedName };
}

/** One bucket per key: watched > maybe-later > to-watch */
function normalizeStatusSets(items, w, m) {
  const keys = new Set();
  for (const row of items) {
    const k = listKey(row);
    if (k) keys.add(k);
  }
  const nw = new Set();
  const nm = new Set();
  for (const k of keys) {
    if (w.has(k)) nw.add(k);
    else if (m.has(k)) nm.add(k);
  }
  return { watched: nw, maybeLater: nm };
}

async function resolveSharedListId(db, name) {
  const snap = await db.collection("sharedLists").get();
  const lower = name.toLowerCase().trim();
  const match = snap.docs.find((d) => {
    const n = String(d.data().name || "").toLowerCase().trim();
    return n === lower || n.includes(lower) || lower.includes(n);
  });
  if (!match) throw new Error(`No shared list found matching "${name}"`);
  return { id: match.id, name: match.data().name || "" };
}

function rowForPersonalItem(row, registryWrites) {
  if (!row || typeof row !== "object") return null;
  if (row.registryId) return { registryId: row.registryId };
  const rid = registryDocIdFromItem(row);
  const payload = payloadForRegistry({ ...row, registryId: rid });
  registryWrites.push({ rid, payload });
  return { registryId: rid };
}

async function commitBatches(db, ops) {
  const chunk = 400;
  for (let i = 0; i < ops.length; i += chunk) {
    const batch = db.batch();
    for (const op of ops.slice(i, i + chunk)) {
      batch.set(db.collection("titleRegistry").doc(op.rid), op.payload, { merge: true });
    }
    await batch.commit();
  }
}

async function main() {
  const { write, uid, sharedName } = parseArgs();
  if (!uid) {
    console.error("Usage: node scripts/move-personal-to-shared.mjs [--write] <uid> [shared list name]");
    console.error("Or set USER_UID");
    process.exit(1);
  }

  const db = getDb();
  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) throw new Error(`users/${uid} not found`);

  const defId = String(userSnap.data()?.defaultPersonalListId || "").trim();
  if (!defId) throw new Error("No defaultPersonalListId on user doc");

  const plRef = userRef.collection("personalLists").doc(defId);
  const plSnap = await plRef.get();
  if (!plSnap.exists) throw new Error(`users/${uid}/personalLists/${defId} not found`);

  const personal = plSnap.data();
  const personalName = String(personal.name || "").trim() || "(unnamed)";
  const personalItems = Array.isArray(personal.items) ? personal.items : [];
  const pW = new Set(personal.watched || []);
  const pM = new Set(personal.maybeLater || []);

  const { id: sharedId, name: resolvedSharedName } = await resolveSharedListId(db, sharedName);
  const shRef = db.collection("sharedLists").doc(sharedId);
  const shSnap = await shRef.get();
  if (!shSnap.exists) throw new Error(`sharedLists/${sharedId} missing`);
  const sh = shSnap.data();

  let items = Array.isArray(sh.items) ? [...sh.items] : [];
  let sW = new Set(sh.watched || []);
  let sM = new Set(sh.maybeLater || []);

  const existingKeys = new Set(items.map((m) => listKey(m)));
  const registryWrites = [];
  let addedCount = 0;

  /** Normalized { registryId } rows + map legacy listKey → canonical id */
  const personalKeyToRegistry = new Map();
  const normalizedPersonalRows = [];
  for (const row of personalItems) {
    const stored = rowForPersonalItem(row, registryWrites);
    if (!stored?.registryId) continue;
    normalizedPersonalRows.push(stored);
    personalKeyToRegistry.set(listKey(row), stored.registryId);
    personalKeyToRegistry.set(stored.registryId, stored.registryId);
  }

  function personalStatusForRowKey(canonicalKey) {
    const keysToCheck = new Set([canonicalKey]);
    for (const [legacy, rid] of personalKeyToRegistry) {
      if (rid === canonicalKey && legacy !== canonicalKey) keysToCheck.add(legacy);
    }
    for (const k of keysToCheck) {
      if (pW.has(k)) return "watched";
    }
    for (const k of keysToCheck) {
      if (pM.has(k)) return "maybe-later";
    }
    return "to-watch";
  }

  for (const stored of normalizedPersonalRows) {
    const key = stored.registryId;
    if (existingKeys.has(key)) continue;
    items.push(stored);
    existingKeys.add(key);
    addedCount++;
    const st = personalStatusForRowKey(key);
    if (st === "watched") sW.add(key);
    else if (st === "maybe-later") sM.add(key);
  }

  function addOrphanKeys(set, addToStatus) {
    for (const rawKey of set) {
      const key = personalKeyToRegistry.get(rawKey) || rawKey;
      if (existingKeys.has(key)) continue;
      items.push({ registryId: key });
      existingKeys.add(key);
      addedCount++;
      addToStatus(key);
    }
  }

  addOrphanKeys(pW, (k) => sW.add(k));
  addOrphanKeys(pM, (k) => sM.add(k));

  /* Keep any shared status key that somehow lacks an items row (avoid silent drops). */
  for (const k of [...sW, ...sM]) {
    if (k && !existingKeys.has(k)) {
      items.push({ registryId: k });
      existingKeys.add(k);
    }
  }

  const normalized = normalizeStatusSets(items, sW, sM);
  sW = normalized.watched;
  sM = normalized.maybeLater;

  console.log(`User: ${uid}`);
  console.log(`Personal list: "${personalName}" (${defId}) — ${personalItems.length} items`);
  console.log(`Shared list: "${resolvedSharedName}" (${sharedId}) — was ${(sh.items || []).length} items, +${addedCount} new → ${items.length} total`);
  console.log(`Registry upserts (legacy rows): ${registryWrites.length}`);
  console.log(`Status counts — watched: ${sW.size}, maybeLater: ${sM.size}`);
  console.log(write ? "MODE: WRITE" : "MODE: dry-run (pass --write to apply)");

  if (!write) return;

  await commitBatches(db, registryWrites);

  await shRef.set(
    {
      items,
      watched: [...sW],
      maybeLater: [...sM],
      archive: FieldValue.delete(),
    },
    { merge: true }
  );

  await plRef.set(
    {
      items: [],
      watched: [],
      maybeLater: [],
      archive: FieldValue.delete(),
    },
    { merge: true }
  );

  console.log("Done: shared list updated; default personal list cleared.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
