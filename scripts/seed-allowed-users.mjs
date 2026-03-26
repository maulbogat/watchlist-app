/**
 * One-time (or idempotent) seed: allowedUsers for existing accounts.
 *
 * Usage: node scripts/seed-allowed-users.mjs [--write]
 *
 * Emails / UIDs (project-specific):
 *   maulbogat@gmail.com        → fSyHdUXB56fBTeKlNFXPiAq1Lip2
 *   keshetrosental@gmail.com   → TaCuVF6CUCRmC86BBYI5uxSXmvG2
 */
import { getDb } from "./lib/admin-init.mjs";

const SEED = [
  { email: "maulbogat@gmail.com", uid: "fSyHdUXB56fBTeKlNFXPiAq1Lip2" },
  { email: "keshetrosental@gmail.com", uid: "TaCuVF6CUCRmC86BBYI5uxSXmvG2" },
];

const write = process.argv.includes("--write");

async function main() {
  const db = getDb();
  const now = new Date().toISOString();
  for (const row of SEED) {
    const key = row.email.trim().toLowerCase();
    const ref = db.collection("allowedUsers").doc(key);
    const snap = await ref.get();
    console.log(`${key}: exists=${snap.exists}`);
    if (write) {
      await ref.set(
        {
          uid: row.uid,
          invitedBy: "self",
          invitedAt: now,
          acceptedAt: now,
        },
        { merge: true }
      );
      console.log(`  → wrote allowedUsers/${key}`);
    }
  }
  if (!write) {
    console.log("\nDry run. Pass --write to apply.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
