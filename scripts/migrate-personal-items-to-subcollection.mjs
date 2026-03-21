/**
 * One-time migration (Admin SDK): move legacy users/{uid}.items (+ status arrays + listName)
 * into users/{uid}/personalLists/{newId} and set defaultPersonalListId.
 *
 * Skips users who already have defaultPersonalListId pointing at an existing subdoc.
 *
 * Usage:
 *   node scripts/migrate-personal-items-to-subcollection.mjs --dry-run
 *   node scripts/migrate-personal-items-to-subcollection.mjs --write
 */
import { FieldValue } from "firebase-admin/firestore";
import { getDb } from "./lib/admin-init.mjs";

const dryRun = !process.argv.includes("--write");

function randomId() {
  return Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
}

async function migrateUser(db, uid, userRef, data) {
  let defId = typeof data.defaultPersonalListId === "string" ? data.defaultPersonalListId.trim() : "";
  if (defId) {
    const plSnap = await userRef.collection("personalLists").doc(defId).get();
    if (plSnap.exists) return { status: "skip", reason: "already has default list doc" };
    if (dryRun) {
      return { status: "would_fix", reason: "orphan defaultPersonalListId" };
    }
    await userRef.update({ defaultPersonalListId: FieldValue.delete() });
  }

  const subSnap = await userRef.collection("personalLists").get();
  if (subSnap.docs.length === 1) {
    const onlyId = subSnap.docs[0].id;
    if (dryRun) {
      return { status: "would_set_default", onlyId };
    }
    await userRef.set({ defaultPersonalListId: onlyId }, { merge: true });
    return { status: "set_default", onlyId };
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

  if (!hasPayload) {
    return { status: "skip", reason: "nothing on user doc to migrate" };
  }

  const newId = randomId();
  if (dryRun) {
    return {
      status: "would_migrate",
      newId,
      counts: { items: items.length, watched: watched.length, maybeLater: maybeLater.length, archive: archive.length },
    };
  }

  const plRef = userRef.collection("personalLists").doc(newId);
  await plRef.set({
    name: listName,
    items,
    watched,
    maybeLater,
    archive,
    createdAt: new Date().toISOString(),
  });
  await userRef.update({
    defaultPersonalListId: newId,
    items: FieldValue.delete(),
    watched: FieldValue.delete(),
    maybeLater: FieldValue.delete(),
    archive: FieldValue.delete(),
    listName: FieldValue.delete(),
  });
  return { status: "migrated", newId };
}

async function main() {
  const db = getDb();
  const usersSnap = await db.collection("users").get();
  let migrated = 0;
  let skipped = 0;
  let setDefault = 0;

  for (const d of usersSnap.docs) {
    const uid = d.id;
    const res = await migrateUser(db, uid, d.ref, d.data() || {});
    if (res.status === "migrated" || res.status === "would_migrate") {
      migrated++;
      console.log(
        `${dryRun ? "[dry-run] " : ""}${uid}: ${res.status}${res.counts ? " " + JSON.stringify(res.counts) : ""}`
      );
    } else if (res.status === "set_default" || res.status === "would_set_default") {
      setDefault++;
      console.log(`${dryRun ? "[dry-run] " : ""}${uid}: ${res.status} default=${res.onlyId}`);
    } else {
      skipped++;
    }
  }

  console.log(
    `\nDone (${dryRun ? "dry-run" : "write"}). migrated=${migrated} setDefault=${setDefault} skipped=${skipped} totalUsers=${usersSnap.size}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
