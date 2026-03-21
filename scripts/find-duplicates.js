/**
 * Find duplicate title+year entries in titleRegistry (same display key, different doc ids).
 * Run: node scripts/find-duplicates.js
 */
import { getDb } from "./lib/admin-init.mjs";

async function main() {
  const db = getDb();
  const snap = await db.collection("titleRegistry").get();
  const byKey = {};
  for (const d of snap.docs) {
    const m = { registryId: d.id, ...d.data() };
    const k = `${String(m.title || "").toLowerCase()}|${m.year ?? ""}`;
    if (!byKey[k]) byKey[k] = [];
    byKey[k].push(m);
  }
  const dups = Object.entries(byKey).filter(([, v]) => v.length > 1);
  if (dups.length) {
    console.log("Duplicates (same title|year, multiple registry docs):");
    dups.forEach(([k, arr]) => {
      console.log(`  ${k}: ${arr.length} docs → ${arr.map((x) => x.registryId).join(", ")}`);
    });
  } else {
    console.log("No duplicates found.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
