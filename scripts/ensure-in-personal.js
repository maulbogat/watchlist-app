/**
 * Ensure a title is in a user's personal list (matches main list items by title).
 * Run: node scripts/ensure-in-personal.js "1941" <uid>
 */
import { getDb } from "./lib/admin-init.mjs";
import { loadAllRegistryMap, hydrateListRow } from "./lib/registry-query.mjs";

async function main() {
  const [titleArg, uid] = process.argv.slice(2);
  if (!titleArg || !uid) {
    console.error('Usage: node scripts/ensure-in-personal.js "1941" <uid>');
    console.error("Get UID: node scripts/list-users.js");
    process.exit(1);
  }

  const db = getDb();
  const regMap = await loadAllRegistryMap(db);
  const userSnap = await db.collection("users").doc(uid).get();
  if (!userSnap.exists) {
    console.error("User not found");
    process.exit(1);
  }
  const userData = userSnap.data();
  const userItems = Array.isArray(userData.items) ? userData.items : [];
  const t = String(titleArg).trim().toLowerCase();

  const movie = userItems
    .map((row) => hydrateListRow(row, regMap))
    .find((m) => m && String(m.title || "").trim().toLowerCase() === t);

  if (movie) {
    console.log(`"${movie.title}" is in personal list.`);
  } else {
    console.error(
      `"${titleArg}" not found in user's items. Add it via the app, bookmarklet, or scripts/add-movie.js / titleRegistry.`
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
