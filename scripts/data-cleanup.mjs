#!/usr/bin/env node
/**
 * Comprehensive data cleanup script.
 *
 * Operations (run in order):
 *  1. Add every titleRegistry entry to "My list" as watched (if not already there)
 *  2. Add every titleRegistry entry to "Our list" as watched, attributed to Roy (if not already there)
 *  3. Delete every list that is not "My list" or "Our list"
 *  4. Delete every Firestore user doc that is not Roy or Keshet
 *  5. Set all items on My list and Our list to watched; clear maybeLater and archive
 *  6. Clear favorites (liked) for Roy and Keshet
 *
 * Usage:
 *   node scripts/data-cleanup.mjs           # dry run (prints what would happen)
 *   node scripts/data-cleanup.mjs --write   # apply changes
 *
 * Required env: WATCHLIST_MY_LIST_UID (Roy's Firebase Auth UID)
 */
import "dotenv/config";
import { createRequire } from "module";
import { getDb } from "./lib/admin-init.mjs";
import { resolveMyListPersonalRef } from "./lib/resolve-my-list-ref.mjs";

const require = createRequire(import.meta.url);
const { listKey } = require("../src/api-lib/registry-id.cjs");

function itemKey(item) {
  if (!item || typeof item !== "object") return null;
  return item.registryId || listKey(item) || null;
}

async function main() {
  const write = process.argv.includes("--write");
  const royUid = (process.env.WATCHLIST_MY_LIST_UID || "").trim();
  if (!royUid) {
    console.error("Set WATCHLIST_MY_LIST_UID to Roy's Firebase Auth UID.");
    process.exit(1);
  }

  const db = getDb();
  const now = new Date().toISOString();

  // ─── Load titleRegistry ───────────────────────────────────────────────────
  console.log("\n=== Loading titleRegistry ===");
  const regSnap = await db.collection("titleRegistry").get();
  const allRegistryIds = regSnap.docs.map((d) => d.id);
  console.log(`Catalog: ${allRegistryIds.length} titles`);

  // ─── Resolve My list ─────────────────────────────────────────────────────
  console.log("\n=== Resolving My list ===");
  const myListRef = await resolveMyListPersonalRef(db, royUid);
  const myListSnap = await myListRef.get();
  if (!myListSnap.exists) {
    console.error("My list not found at", myListRef.path);
    process.exit(1);
  }
  console.log(`My list: ${myListRef.path}`);

  // ─── Resolve Our list ────────────────────────────────────────────────────
  console.log("\n=== Resolving Our list ===");
  const sharedSnap = await db.collection("sharedLists").get();
  const ourListDoc = sharedSnap.docs.find((d) => {
    const n = String(d.data()?.name || "")
      .trim()
      .toLowerCase();
    return n === "our list" || n.includes("our list");
  });
  if (!ourListDoc) {
    console.error("No shared list named 'Our list' found.");
    process.exit(1);
  }
  const ourListRef = ourListDoc.ref;
  const ourListData = ourListDoc.data();
  const ourListMembers = Array.isArray(ourListData.members) ? ourListData.members : [];
  console.log(
    `Our list: ${ourListRef.path} | "${ourListData.name}" | members: [${ourListMembers.join(", ")}]`
  );

  // ─── Determine Keshet's UID ───────────────────────────────────────────────
  const keshetUid = ourListMembers.find((uid) => uid !== royUid);
  if (!keshetUid) {
    console.error(
      "Could not determine Keshet's UID from Our list members (no member other than Roy found)."
    );
    process.exit(1);
  }
  console.log(`Roy UID:   ${royUid}`);
  console.log(`Keshet UID: ${keshetUid}`);

  // ─── Roy's display name ───────────────────────────────────────────────────
  const royUserSnap = await db.collection("users").doc(royUid).get();
  const royDisplayName = royUserSnap.data()?.displayName || "Roy";
  console.log(`Roy display name: "${royDisplayName}"`);

  // ─── Op 1: Ensure all catalog titles are on My list as watched ────────────
  console.log("\n=== Op 1: Ensure catalog → My list (watched) ===");
  {
    const myData = myListSnap.data() || {};
    const existingItems = Array.isArray(myData.items) ? myData.items : [];
    const existingKeys = new Set(existingItems.map(itemKey).filter(Boolean));
    const existingWatched = new Set(Array.isArray(myData.watched) ? myData.watched : []);

    const toAdd = allRegistryIds.filter((rid) => !existingKeys.has(rid));
    const existingNotWatched = [...existingKeys].filter((k) => !existingWatched.has(k));

    console.log(`  Already on My list: ${existingItems.length}`);
    console.log(`  Catalog titles to add: ${toAdd.length}`);
    console.log(`  Existing items not yet watched: ${existingNotWatched.length}`);

    if (!write) {
      console.log("  [dry run]");
    } else {
      const newItems = [
        ...existingItems,
        ...toAdd.map((rid) => ({ registryId: rid, addedAt: now })),
      ];
      // watched = union of all catalog IDs (covers existing + new)
      const newWatched = [...new Set([...allRegistryIds])];
      await myListRef.set(
        { items: newItems, watched: newWatched, maybeLater: [], archive: [] },
        { merge: true }
      );
      console.log(`  ✓ My list: ${newItems.length} items, ${newWatched.length} watched`);
    }
  }

  // ─── Op 2: Ensure all catalog titles are on Our list as watched ────────────
  console.log("\n=== Op 2: Ensure catalog → Our list (watched, added by Roy) ===");
  {
    const existingItems = Array.isArray(ourListData.items) ? ourListData.items : [];
    const existingKeys = new Set(existingItems.map(itemKey).filter(Boolean));
    const existingWatched = new Set(Array.isArray(ourListData.watched) ? ourListData.watched : []);

    const toAdd = allRegistryIds.filter((rid) => !existingKeys.has(rid));
    const existingNotWatched = [...existingKeys].filter((k) => !existingWatched.has(k));

    console.log(`  Already on Our list: ${existingItems.length}`);
    console.log(`  Catalog titles to add: ${toAdd.length}`);
    console.log(`  Existing items not yet watched: ${existingNotWatched.length}`);

    if (!write) {
      console.log("  [dry run]");
    } else {
      const newItems = [
        ...existingItems,
        ...toAdd.map((rid) => ({
          registryId: rid,
          addedAt: now,
          addedByUid: royUid,
          addedByDisplayName: royDisplayName,
        })),
      ];
      const newWatched = [...new Set([...allRegistryIds])];
      await ourListRef.set(
        { items: newItems, watched: newWatched, maybeLater: [], archive: [] },
        { merge: true }
      );
      console.log(`  ✓ Our list: ${newItems.length} items, ${newWatched.length} watched`);
    }
  }

  // ─── Op 3: Delete extra lists ─────────────────────────────────────────────
  console.log("\n=== Op 3: Delete extra lists ===");
  {
    // Personal lists: keep only Roy's My list
    const usersSnap = await db.collection("users").get();
    let deletedPersonal = 0;
    for (const userDoc of usersSnap.docs) {
      const uid = userDoc.id;
      const plSnap = await userDoc.ref.collection("personalLists").get();
      for (const plDoc of plSnap.docs) {
        const isMyList = uid === royUid && plDoc.ref.path === myListRef.path;
        if (isMyList) {
          console.log(`  keep  ${plDoc.ref.path}  (My list)`);
        } else {
          console.log(`  delete ${plDoc.ref.path}`);
          if (write) {
            await plDoc.ref.delete();
            deletedPersonal++;
          }
        }
      }
    }

    // Shared lists: keep only Our list
    let deletedShared = 0;
    for (const slDoc of sharedSnap.docs) {
      if (slDoc.ref.path === ourListRef.path) {
        console.log(`  keep  ${slDoc.ref.path}  (Our list)`);
      } else {
        console.log(`  delete ${slDoc.ref.path}`);
        if (write) {
          await slDoc.ref.delete();
          deletedShared++;
        }
      }
    }

    if (write) {
      console.log(`  ✓ Deleted ${deletedPersonal} personal list(s), ${deletedShared} shared list(s)`);
    } else {
      console.log("  [dry run]");
    }
  }

  // ─── Op 4: Delete extra user docs ─────────────────────────────────────────
  console.log("\n=== Op 4: Delete extra user docs ===");
  {
    const keepUids = new Set([royUid, keshetUid]);
    const usersSnap2 = await db.collection("users").get();
    let deletedUsers = 0;
    for (const userDoc of usersSnap2.docs) {
      const uid = userDoc.id;
      if (keepUids.has(uid)) {
        console.log(`  keep  users/${uid}`);
      } else {
        console.log(`  delete users/${uid}`);
        if (write) {
          await userDoc.ref.delete();
          deletedUsers++;
        }
      }
    }

    // allowedUsers: keyed by email; each doc may or may not have a `uid` field.
    // Only delete docs where uid is known and not in keepUids.
    const allowedSnap = await db.collection("allowedUsers").get();
    let deletedAllowed = 0;
    for (const doc of allowedSnap.docs) {
      const uid = doc.data()?.uid ?? null;
      if (uid && !keepUids.has(uid)) {
        console.log(`  delete allowedUsers/${doc.id}  (uid: ${uid})`);
        if (write) {
          await doc.ref.delete();
          deletedAllowed++;
        }
      } else {
        console.log(`  keep  allowedUsers/${doc.id}  (uid: ${uid ?? "unknown"})`);
      }
    }

    if (write) {
      console.log(
        `  ✓ Deleted ${deletedUsers} user doc(s), ${deletedAllowed} allowedUsers doc(s)`
      );
      console.log(
        "  Note: Firebase Auth accounts for deleted users still exist — remove them via the Firebase console if needed."
      );
    } else {
      console.log("  [dry run]");
    }
  }

  // ─── Op 5: All remaining items → watched (covered by ops 1 & 2) ───────────
  // Ops 1 and 2 already set watched = all catalog IDs and clear maybeLater/archive.
  // Nothing more to do here.
  console.log("\n=== Op 5: Set all to watched ===");
  console.log("  Covered by ops 1 & 2 (watched arrays already set to full catalog).");

  // ─── Op 6: Clear favorites for Roy and Keshet ─────────────────────────────
  console.log("\n=== Op 6: Clear favorites (liked) ===");
  for (const uid of [royUid, keshetUid]) {
    console.log(`  Clearing favorites for ${uid}`);
    if (write) {
      await db.collection("users").doc(uid).set({ favorites: {} }, { merge: true });
    }
  }
  if (!write) {
    console.log("  [dry run]");
  } else {
    console.log("  ✓ Favorites cleared");
  }

  console.log(write ? "\nAll done." : "\nDry run complete. Pass --write to apply.");
}

main().catch((err) => {
  console.error("Fatal:", err.message || err);
  process.exit(1);
});
