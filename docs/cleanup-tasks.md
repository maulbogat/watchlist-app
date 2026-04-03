# Cleanup Tasks

Post-deprecation legacy code that wasn't removed in the initial pass because it requires
more careful thought or is in admin-only paths.

---

## 1. Remove legacy `archive` / `maybe-later` Firestore fields

**Status:** Data cleanup script (`scripts/data-cleanup.mjs --write`) must be run first.

**After running the script**, these files still contain dead code that can be deleted:

- **`src/firebase.ts`** — `archiveSet`, `maybeLaterSet`, `archive`, `maybeLater` variables
  in `mergeRegistryIntoList()` and `addToPersonalList()` / `addToSharedList()`. The arrays
  are read from Firestore and written back for backward compat; once the data is clean they
  can be dropped entirely.
- **`src/types/index.ts`** — `PersonalList.maybeLater`, `PersonalList.archive`,
  `SharedList.maybeLater`, `SharedList.archive`, `StatusData.maybeLater`, `StatusData.archive`
  fields still exist on the TypeScript types for structural compatibility.
- **`src/lib/storage.ts`** — `FilterPrefsSnapshot.currentGenre` field still read/written for
  backward compat with old localStorage values.
- **`src/store/useAppStore.ts`** — `currentGenre` / `setCurrentGenre` state still exists (read
  by session restore for backward compat). Remove once old prefs have expired.

## 2. Admin list matrix — remove "archive" UI choice

**File:** `src/lib/admin-list-matrix.ts`, `src/data/admin-list-matrix.ts`,
`src/pages/AdminListMatrixPage.tsx`

`MatrixUiChoice` still includes `"archive"` as a UI option. The admin matrix page lets
admins set items to "archive" status, which is now deprecated. Steps:
1. Remove `"archive"` from `MatrixUiChoice` type.
2. Update `membershipToMatrixChoice` to never return `"archive"`.
3. Update `AdminListMatrixPage.tsx` to remove the "archive" column/option from the UI.
4. Update the descriptive comment at line 175 in `AdminListMatrixPage.tsx`.

## 3. Remove genre-related dead code from Firestore library

**Files:** `src/lib/watchlistFilters.ts`

`getUniqueGenresFromMovies`, `isGenrePresentInMovies` were removed from the filter pipeline
but the functions could be deleted entirely if nothing else imports them. Verify with a
codebase-wide grep before deleting.

## 4. `currentGenre` Zustand state and genre CSS

After confirming no genre filter restoration issues in production:
- Remove `currentGenre` + `setCurrentGenre` from `useAppStore`.
- Remove genre-related CSS classes from `styles.css`
  (`.watchlist-genre-popover-*`, `.watchlist-toolbar-genre-wrap`).
