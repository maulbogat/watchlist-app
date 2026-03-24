/**
 * Remove legacy root fields on users/{uid}: items, watched, maybeLater, archive, listName.
 * Current data lives under users/{uid}/personalLists/{listId}.
 *
 * Also fixes cases the client migration misses: exactly one personalList but legacy roots
 * still present (sets defaultPersonalListId and deletes roots).
 * Migrates root payload into a new personalList when there are zero subdocs (same as
 * migrate-personal-items-to-subcollection.mjs).
 *
 * Does not delete the personalLists subcollection or any other fields.
 *
 * Usage:
 *   node scripts/clean-legacy-user-fields.mjs --dry-run
 *   node scripts/clean-legacy-user-fields.mjs --write
 *   node scripts/clean-legacy-user-fields.mjs --uid <UID> --dry-run
 */
import { FieldValue } from "firebase-admin/firestore";
import { getDb } from "./lib/admin-init.mjs";

const LEGACY_KEYS = ["items", "watched", "maybeLater", "archive", "listName"];

const dryRun = process.argv.includes("--dry-run") || !process.argv.includes("--write");
const uidArg = (() => {
  const i = process.argv.indexOf("--uid");
  if (i === -1 || !process.argv[i + 1]) return null;
  return process.argv[i + 1].trim();
})();

function randomId() {
  return Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
}

function legacyKeysPresent(data) {
  return LEGACY_KEYS.filter((k) => data[k] !== undefined);
}

function hasLegacyPayload(data) {
  const items = Array.isArray(data.items) ? data.items : [];
  const watched = Array.isArray(data.watched) ? data.watched : [];
  const maybeLater = Array.isArray(data.maybeLater) ? data.maybeLater : [];
  const archive = Array.isArray(data.archive) ? data.archive : [];
  const listName = typeof data.listName === "string" ? data.listName.trim() : "";
  return (
    items.length > 0 ||
    watched.length > 0 ||
    maybeLater.length > 0 ||
    archive.length > 0 ||
    listName.length > 0
  );
}

/**
 * @returns {Promise<{ label: string, detail?: object }>}
 */
async function cleanOneUser(userRef) {
  const uid = userRef.id;

  let snap = await userRef.get();
  if (!snap.exists) return { label: "missing_user" };
  let data = snap.data() ?? {};

  let defId = typeof data.defaultPersonalListId === "string" ? data.defaultPersonalListId.trim() : "";

  if (defId) {
    const plSnap = await userRef.collection("personalLists").doc(defId).get();
    if (!plSnap.exists) {
      if (dryRun) {
        data = { ...data, defaultPersonalListId: undefined };
        defId = "";
      } else {
        await userRef.update({ defaultPersonalListId: FieldValue.delete() });
        snap = await userRef.get();
        data = snap.data() ?? {};
        defId = "";
      }
    }
  }

  const subSnap = await userRef.collection("personalLists").get();

  if (subSnap.docs.length === 1) {
    const onlyId = subSnap.docs[0].id;
    if (data.defaultPersonalListId !== onlyId) {
      if (dryRun) {
        data = { ...data, defaultPersonalListId: onlyId };
        defId = onlyId;
      } else {
        await userRef.set({ defaultPersonalListId: onlyId }, { merge: true });
        data = { ...data, defaultPersonalListId: onlyId };
        defId = onlyId;
      }
    }
  }

  if (subSnap.docs.length === 0 && hasLegacyPayload(data)) {
    const items = Array.isArray(data.items) ? data.items : [];
    const watched = Array.isArray(data.watched) ? data.watched : [];
    const maybeLater = Array.isArray(data.maybeLater) ? data.maybeLater : [];
    const archive = Array.isArray(data.archive) ? data.archive : [];
    const listName = typeof data.listName === "string" ? data.listName.trim() : "";
    const newId = randomId();
    if (dryRun) {
      return {
        label: "would_migrate_root_to_subcollection",
        detail: {
          uid,
          newId,
          counts: {
            items: items.length,
            watched: watched.length,
            maybeLater: maybeLater.length,
            archive: archive.length,
          },
        },
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
    return { label: "migrated", detail: { uid, newId } };
  }

  snap = await userRef.get();
  data = snap.data() ?? {};
  defId = typeof data.defaultPersonalListId === "string" ? data.defaultPersonalListId.trim() : "";

  const toStrip = legacyKeysPresent(data);
  if (toStrip.length === 0) {
    return { label: "ok_no_legacy_fields" };
  }

  const defaultDocExists = defId ? (await userRef.collection("personalLists").doc(defId).get()).exists : false;

  if (defaultDocExists) {
    if (dryRun) {
      return { label: "would_strip", detail: { uid, keys: toStrip } };
    }
    const updates = Object.fromEntries(toStrip.map((k) => [k, FieldValue.delete()]));
    await userRef.update(updates);
    return { label: "stripped", detail: { uid, keys: toStrip } };
  }

  const subCount = (await userRef.collection("personalLists").get()).size;
  if (subCount > 1) {
    return {
      label: "skip_needs_valid_default",
      detail: { uid, keys: toStrip, subCount, defId: defId || null },
    };
  }

  if (subCount === 1) {
    const onlyId = (await userRef.collection("personalLists").limit(1).get()).docs[0]?.id;
    if (onlyId) {
      if (dryRun) {
        return { label: "would_set_default_and_strip", detail: { uid, onlyId, keys: toStrip } };
      }
      await userRef.set({ defaultPersonalListId: onlyId }, { merge: true });
      const updates = Object.fromEntries(toStrip.map((k) => [k, FieldValue.delete()]));
      await userRef.update(updates);
      return { label: "set_default_and_stripped", detail: { uid, onlyId, keys: toStrip } };
    }
  }

  return { label: "skip_ambiguous", detail: { uid, keys: toStrip, subCount } };
}

async function main() {
  const db = getDb();
  const usersRef = db.collection("users");
  let query = usersRef;
  if (uidArg) {
    const doc = await usersRef.doc(uidArg).get();
    if (!doc.exists) {
      console.error(`No user document for uid=${uidArg}`);
      process.exit(1);
    }
    const res = await cleanOneUser(doc.ref);
    console.log(JSON.stringify({ dryRun, ...res }, null, 2));
    return;
  }

  const usersSnap = await query.get();
  const counts = {};
  for (const d of usersSnap.docs) {
    const res = await cleanOneUser(d.ref);
    counts[res.label] = (counts[res.label] || 0) + 1;
    if (
      res.label !== "ok_no_legacy_fields" &&
      res.label !== "missing_user" &&
      (dryRun ||
        res.label === "stripped" ||
        res.label === "migrated" ||
        res.label === "set_default_and_stripped")
    ) {
      const line =
        res.detail != null
          ? `${d.id} ${res.label} ${JSON.stringify(res.detail)}`
          : `${d.id} ${res.label}`;
      console.log(line);
    }
  }
  console.log(`\nSummary (${dryRun ? "dry-run" : "write"}):`, counts);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
