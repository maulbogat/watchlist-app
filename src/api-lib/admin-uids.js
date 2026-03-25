/**
 * Admin Firebase UIDs allowed to call protected Netlify functions.
 * Keep in sync with `src/config/admin.ts` (`ADMIN_UIDS` / `isAdmin`).
 */
const ADMIN_UIDS = Object.freeze(new Set(["fSyHdUXB56fBTeKlNFXPiAq1Lip2"]));

module.exports = { ADMIN_UIDS };
