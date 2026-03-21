/**
 * Print all titles for a user (legacy users/{uid}.items if present + all personalLists),
 * then delete the user doc, personalLists subcollection, and remove uid from sharedLists.members.
 *
 * Usage: node scripts/output-and-delete-user.mjs <uid> --write
 *        node scripts/output-and-delete-user.mjs <uid>   # dry-run (print only)
 */
import { getDb } from "./lib/admin-init.mjs";

const uid = process.argv[2];
const write = process.argv.includes("--write");

if (!uid || uid.startsWith("-")) {
  console.error("Usage: node scripts/output-and-delete-user.mjs <uid> [--write]");
  process.exit(1);
}

function titleFor(trMap, rid) {
  const row = trMap.get(rid);
  if (!row) return "(not in titleRegistry)";
  const y = row.year != null && row.year !== "" ? row.year : "—";
  return `${row.title || "?"} (${y})`;
}

function rowsFromItems(items, trMap) {
  const out = [];
  if (!Array.isArray(items)) return out;
  let i = 0;
  for (const m of items) {
    i++;
    const rid = m?.registryId;
    if (rid) out.push({ n: i, rid, label: titleFor(trMap, rid) });
    else out.push({ n: i, rid: "(embedded)", label: `${m?.title || "?"} (${m?.year ?? "—"})` });
  }
  return out;
}

async function main() {
  const db = getDb();
  const regSnap = await db.collection("titleRegistry").get();
  const trMap = new Map();
  for (const d of regSnap.docs) trMap.set(d.id, { registryId: d.id, ...d.data() });

  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    console.error("No users/" + uid);
    process.exit(1);
  }

  console.log("\n========== USER " + uid + " ==========\n");

  const udata = userSnap.data();
  console.log("Legacy root list (users/{uid}.items — empty after migration):");
  const mainRows = rowsFromItems(udata.items, trMap);
  mainRows.forEach((r) => console.log(`  ${r.n}. ${r.rid} — ${r.label}`));
  console.log(`  (${mainRows.length} titles)\n`);
  if (udata.defaultPersonalListId) {
    console.log(`defaultPersonalListId: ${udata.defaultPersonalListId}\n`);
  }

  const plSnap = await userRef.collection("personalLists").get();
  if (!plSnap.empty) {
    for (const p of plSnap.docs) {
      const pdata = p.data();
      const nm = pdata.name || "(no name field)";
      console.log(`Personal list subdoc ${p.id} — name: "${nm}"`);
      const pr = rowsFromItems(pdata.items, trMap);
      pr.forEach((r) => console.log(`  ${r.n}. ${r.rid} — ${r.label}`));
      console.log(`  (${pr.length} titles)\n`);
    }
  } else {
    console.log("(no personalLists subcollection docs)\n");
  }

  const sharedSnap = await db.collection("sharedLists").get();
  const memberOf = [];
  for (const d of sharedSnap.docs) {
    const m = d.data().members;
    if (Array.isArray(m) && m.includes(uid)) {
      memberOf.push(d.id);
    }
  }
  if (memberOf.length) {
    console.log("Member of sharedLists:", memberOf.join(", "));
    console.log("(uid will be removed from members on --write)\n");
  }

  if (!write) {
    console.log("Dry run. Pass --write to delete user + personalLists + strip from shared members.");
    return;
  }

  const batchDeletes = [];
  for (const p of plSnap.docs) {
    batchDeletes.push(p.ref.delete());
  }
  await Promise.all(batchDeletes);

  for (const d of sharedSnap.docs) {
    const data = d.data();
    const members = Array.isArray(data.members) ? data.members : [];
    if (!members.includes(uid)) continue;
    await d.ref.update({
      members: members.filter((x) => x !== uid),
    });
    console.log("Removed uid from sharedLists/" + d.id + " members");
  }

  await userRef.delete();
  console.log("\nDeleted users/" + uid);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
