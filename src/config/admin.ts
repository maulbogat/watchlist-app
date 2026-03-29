/** Keep in sync with `src/api-lib/admin-uids.js`. */
export const ADMIN_UIDS: string[] = ["fSyHdUXB56fBTeKlNFXPiAq1Lip2"];

export function isAdmin(uid: string | undefined | null): boolean {
  return !!uid && ADMIN_UIDS.includes(uid);
}
