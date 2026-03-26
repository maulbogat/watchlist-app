/**
 * Move a WhatsApp-linked phone from one Firebase Auth user to another.
 *
 * Updates:
 * - phoneIndex/{digits}: uid → destination user (keeps defaultAddListId / defaultListType)
 * - users/{fromUid}.phoneNumbers: arrayRemove(digits)
 * - users/{toUid}.phoneNumbers: arrayUnion(digits)
 * - verificationCodes/{digits}: deleted if present (stale in-flight verify)
 *
 * After migration, ensure the default list on phoneIndex is valid for the destination user
 * (personal subdoc under users/{toUid}/personalLists, or a shared list that includes toUid in members).
 *
 * Usage:
 *   node scripts/migrate-whatsapp-phone-to-user.mjs 972544790382 fSyHdUXB56fBTeKlNFXPiAq1Lip2 TaCuVF6CUCRmC86BBYI5uxSXmvG2
 *   node scripts/migrate-whatsapp-phone-to-user.mjs ... --write
 */
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { FieldValue } from "firebase-admin/firestore";
import { getDb } from "./lib/admin-init.mjs";

dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env") });

const phoneDigits = String(process.argv[2] || "").replace(/\D/g, "");
const fromUid = process.argv[3] || "";
const toUid = process.argv[4] || "";
const write = process.argv.includes("--write");
const skipSharedMember = process.argv.includes("--skip-shared-member");

if (!phoneDigits || !fromUid || !toUid || fromUid === toUid) {
  console.error(
    "Usage: node scripts/migrate-whatsapp-phone-to-user.mjs <phoneDigits> <fromUid> <toUid> [--write]"
  );
  process.exit(1);
}

async function main() {
  const db = getDb();
  const phoneRef = db.collection("phoneIndex").doc(phoneDigits);
  const fromRef = db.collection("users").doc(fromUid);
  const toRef = db.collection("users").doc(toUid);
  const vcRef = db.collection("verificationCodes").doc(phoneDigits);

  const [pSnap, fromSnap, toSnap, vcSnap] = await Promise.all([
    phoneRef.get(),
    fromRef.get(),
    toRef.get(),
    vcRef.get(),
  ]);

  if (!pSnap.exists) {
    console.error(`phoneIndex/${phoneDigits} does not exist. Nothing to migrate.`);
    process.exit(1);
  }

  const p = pSnap.data() || {};
  const currentUid = typeof p.uid === "string" ? p.uid.trim() : "";
  const defaultAddListId = typeof p.defaultAddListId === "string" ? p.defaultAddListId.trim() : "";
  const defaultListType = p.defaultListType === "shared" ? "shared" : "personal";

  console.log("--- Current phoneIndex ---");
  console.log(JSON.stringify({ ...p, uid: currentUid, defaultAddListId, defaultListType }, null, 2));

  if (currentUid !== fromUid && currentUid !== toUid) {
    console.error(
      `\nphoneIndex.uid is "${currentUid}", expected fromUid "${fromUid}" (or already "${toUid}"). Refusing.`
    );
    process.exit(1);
  }
  if (currentUid === toUid) {
    console.log("\nphoneIndex already points to toUid; --write will still sync phoneNumbers + clear verificationCodes if needed.");
  }

  const fromPhones = Array.isArray(fromSnap.data()?.phoneNumbers)
    ? fromSnap.data().phoneNumbers.map((x) => String(x).replace(/\D/g, ""))
    : [];
  const toPhones = Array.isArray(toSnap.data()?.phoneNumbers)
    ? toSnap.data().phoneNumbers.map((x) => String(x).replace(/\D/g, ""))
    : [];

  console.log("\n--- users phoneNumbers (digits) ---");
  console.log(`from ${fromUid}:`, fromPhones);
  console.log(`to   ${toUid}:`, toPhones);

  if (vcSnap.exists) {
    console.log("\nverificationCodes doc exists; will delete on --write.");
  }

  // Validate default target for destination user (warn only)
  let sharedListNeedsMember = false;
  if (defaultAddListId) {
    if (defaultListType === "shared") {
      const sl = await db.collection("sharedLists").doc(defaultAddListId).get();
      const members = sl.exists && Array.isArray(sl.data()?.members) ? sl.data().members : [];
      if (!members.includes(toUid)) {
        sharedListNeedsMember = true;
        console.warn(
          `\n⚠ Destination user is NOT in sharedLists/${defaultAddListId} members. WhatsApp adds will fail until they are a member.`
        );
        if (write && !skipSharedMember) {
          console.log("(With --write) Will add them to members after phone migration.");
        } else if (write && skipSharedMember) {
          console.warn("(--skip-shared-member) Will not add them to the shared list.");
        }
      }
    } else {
      const pl = await toRef.collection("personalLists").doc(defaultAddListId).get();
      if (!pl.exists) {
        console.warn(
          `\n⚠ users/${toUid}/personalLists/${defaultAddListId} does not exist. WhatsApp adds to personal list may fail until phoneIndex default is updated in the app.`
        );
      }
    }
  }

  if (!write) {
    console.log("\nDry run. Pass --write to apply.");
    return;
  }

  const pLatest = await phoneRef.get();
  if (!pLatest.exists) throw new Error("phoneIndex missing before write");
  const u = (pLatest.data() || {}).uid;
  const uidStr = typeof u === "string" ? u.trim() : "";
  if (uidStr && uidStr !== fromUid && uidStr !== toUid) {
    throw new Error(`phoneIndex.uid is ${uidStr}; expected ${fromUid} or ${toUid}; abort`);
  }

  const batch = db.batch();
  batch.set(
    phoneRef,
    {
      uid: toUid,
      updatedAt: new Date().toISOString(),
    },
    { merge: true }
  );
  batch.set(fromRef, { phoneNumbers: FieldValue.arrayRemove(phoneDigits) }, { merge: true });
  batch.set(toRef, { phoneNumbers: FieldValue.arrayUnion(phoneDigits) }, { merge: true });
  if (vcSnap.exists) {
    batch.delete(vcRef);
  }
  await batch.commit();

  console.log("\nDone. phoneIndex.uid →", toUid, "; phone removed from", fromUid, "; phone added to", toUid);

  if (sharedListNeedsMember && write && !skipSharedMember && defaultListType === "shared" && defaultAddListId) {
    await db
      .collection("sharedLists")
      .doc(defaultAddListId)
      .set({ members: FieldValue.arrayUnion(toUid) }, { merge: true });
    console.log(`Added ${toUid} to sharedLists/${defaultAddListId} members.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
