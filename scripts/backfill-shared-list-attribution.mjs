/**
 * Denormalize `displayName` + `photoURL` from `users/{uid}` (and Firebase Auth fallback)
 * onto each `sharedLists/{listId}.items[]` row that has `addedByUid`.
 * The web app preserves these on hydrate when present so avatars work even if client
 * reads of `users/{uid}` fail (cache/offline).
 *
 * Usage:
 *   node scripts/backfill-shared-list-attribution.mjs --dry-run
 *   node scripts/backfill-shared-list-attribution.mjs --write
 *   node scripts/backfill-shared-list-attribution.mjs --write --listId <sharedListId>
 */
import { getAuth } from "firebase-admin/auth";
import { getDb } from "./lib/admin-init.mjs";

const dryRun = !process.argv.includes("--write");
const listArg = process.argv.indexOf("--listId");
const onlyListId =
  listArg !== -1 && process.argv[listArg + 1] ? process.argv[listArg + 1].trim() : null;

const db = getDb();
const auth = getAuth();

async function profileForUid(uid) {
  const snap = await db.collection("users").doc(uid).get();
  let displayName = "";
  let photoURL = "";
  if (snap.exists) {
    const d = snap.data();
    if (typeof d.displayName === "string" && d.displayName.trim()) displayName = d.displayName.trim();
    if (typeof d.photoURL === "string" && d.photoURL.trim()) photoURL = d.photoURL.trim();
  }
  if (!photoURL || !displayName) {
    try {
      const u = await auth.getUser(uid);
      if (!displayName && u.displayName && String(u.displayName).trim()) displayName = String(u.displayName).trim();
      if (!photoURL && u.photoURL && String(u.photoURL).trim()) photoURL = String(u.photoURL).trim();
    } catch {
      /* missing auth user */
    }
  }
  return { displayName, photoURL };
}

function rowNeedsUpdate(row, displayName, photoURL) {
  if (!row || typeof row.addedByUid !== "string" || !row.addedByUid.trim()) return false;
  const d = typeof row.addedByDisplayName === "string" ? row.addedByDisplayName.trim() : "";
  const p = typeof row.addedByPhotoUrl === "string" ? row.addedByPhotoUrl.trim() : "";
  if (displayName && d !== displayName) return true;
  if (photoURL && p !== photoURL) return true;
  if (displayName && !d) return true;
  if (photoURL && !p) return true;
  return false;
}

async function processList(doc) {
  const listId = doc.id;
  const data = doc.data();
  const items = Array.isArray(data.items) ? [...data.items] : [];
  let changed = 0;
  const next = [];
  for (const row of items) {
    if (!row || typeof row !== "object") {
      next.push(row);
      continue;
    }
    const uid = typeof row.addedByUid === "string" ? row.addedByUid.trim() : "";
    if (!uid) {
      next.push(row);
      continue;
    }
    const { displayName, photoURL } = await profileForUid(uid);
    const updated = { ...row };
    if (displayName) updated.addedByDisplayName = displayName;
    else delete updated.addedByDisplayName;
    if (photoURL) updated.addedByPhotoUrl = photoURL;
    else delete updated.addedByPhotoUrl;

    if (rowNeedsUpdate(row, displayName, photoURL)) {
      changed++;
      next.push(dryRun ? row : updated);
    } else {
      next.push(row);
    }
  }
  if (!dryRun && changed > 0) {
    await db.collection("sharedLists").doc(listId).set({ items: next }, { merge: true });
  }
  return { listId, name: data.name || "", itemCount: items.length, changed };
}

async function main() {
  let listsSnap;
  if (onlyListId) {
    const d = await db.collection("sharedLists").doc(onlyListId).get();
    if (!d.exists) {
      console.error(`sharedLists/${onlyListId} not found`);
      process.exit(1);
    }
    listsSnap = { docs: [d], empty: false };
  } else {
    listsSnap = await db.collection("sharedLists").get();
  }

  let totalChanged = 0;
  for (const doc of listsSnap.docs) {
    const { listId, name, itemCount, changed } = await processList(doc);
    if (changed > 0) {
      totalChanged += changed;
      console.log(
        `${dryRun ? "[dry-run] " : ""}sharedLists/${listId} "${name}" — ${changed} row(s) to update (${itemCount} items)`
      );
    }
  }
  console.log(
    `\nDone (${dryRun ? "dry-run" : "write"}). Rows updated (or would be): ${totalChanged}.`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
