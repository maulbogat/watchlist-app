# System Design Document

This document describes **only what exists in this repository** (static site, Netlify functions, Firestore rules, Firebase client module, and operational scripts). It does not specify future or assumed behavior.

---

## Section 1: Services & External Dependencies

| Service name | Purpose | How it's accessed | Authentication | Environment variables |
|--------------|---------|-------------------|----------------|----------------------|
| **Firebase (Firestore)** | Persist watchlists, shared lists, **`titleRegistry`**, user profile (country, list name). | **Client:** Firebase JS SDK v10 in `src/firebase.ts` (`getFirestore`, `doc`, `getDoc`, `setDoc`, etc.). **Server:** `firebase-admin` in Netlify functions and Node scripts. | **Client:** Firebase Auth user JWT (SDK attaches to requests per Firestore rules). **Server:** Service account JSON (base64) for Admin SDK. | **Client:** `VITE_FIREBASE_*` variables (read in `src/config/firebase.ts` via `import.meta.env`). **Server/scripts:** `FIREBASE_SERVICE_ACCOUNT` (base64 JSON). Scripts may also use `serviceAccountKey.json` in project root (per README / `check-upcoming.mjs`). |
| **Firebase Auth** | Google Sign-In for end users. | **Client:** Firebase Auth SDK from npm (`signInWithPopup`, `GoogleAuthProvider`, `onAuthStateChanged`) in `src/firebase.ts`. | OAuth via Google; Firebase-issued ID tokens. | Same Firebase client env vars (`VITE_FIREBASE_*`). |
| **Firebase Analytics** | Optional; skipped when **offline**, in **Vite dev** (`import.meta.env.DEV`), or when blocked. | **Client:** `src/firebase.ts` dynamically imports Analytics only if `shouldLoadWebAnalytics()` passes, then `isSupported()` + `getAnalytics(app)` (avoids Installations `app-offline` noise locally). | Inherits Firebase web app setup. | Uses the same `VITE_FIREBASE_*` values. |
| **The Movie Database (TMDB)** | Resolve IMDb id → TMDB id; poster; genres/year; **YouTube trailer key** from appended `videos`; **watch providers** by region. | **REST:** `https://api.themoviedb.org/3/...` via Node `https.get` in `netlify/functions/add-from-imdb.js`. Same pattern in maintenance scripts (e.g. `scripts/sync-services-from-tmdb.js`, `check-upcoming.mjs` uses `fetch`). **Not** called from the browser watchlist UI. | API key query parameter `api_key`. | `TMDB_API_KEY` in Netlify env; `.env` for local scripts / `check-upcoming.mjs`. |
| **OMDb** | Title metadata by IMDb id; disambiguate movie vs TV when TMDB returns both; fallback row when TMDB has no match. | **REST:** `https://www.omdbapi.com/?i=...&apikey=...` in `add-from-imdb.js` and various scripts. | API key query parameter. | `OMDB_API_KEY` (Netlify + local scripts per README / `.env.example`). |
| **YouTube** | Trailer playback in modal via iframe embed. | **Browser:** `https://www.youtube-nocookie.com/embed/{youtubeId}?...` and link to `youtube.com/watch`. | None for embed (public video ids). | None. |
| **Google Fonts** | UI typography (Bebas Neue, DM Sans). | `<link href="https://fonts.googleapis.com/...">` in HTML. | None. | None. |
| **Netlify** | Host static HTML/CSS/JS; run serverless functions under `/.netlify/functions/*`. | **Browser:** `fetch` to same-origin function paths (e.g. **`log-client-event`** for Axiom ingest with `Authorization: Bearer` ID token). **Functions:** Node.js handlers in `netlify/functions/*.js`. | Functions verify Firebase ID token (cookie or `Authorization: Bearer`) where needed. | `FIREBASE_SERVICE_ACCOUNT`, `OMDB_API_KEY`, `TMDB_API_KEY`, optional `UPCOMING_SYNC_TRIGGER_SECRET`, optional `AXIOM_TOKEN`, optional `AXIOM_DATASET` (server-only; no `VITE_AXIOM_*`). |

**Note:** `.env` is for server/script vars (`process.env`) and `.env.local` is for client Vite vars (`import.meta.env`). The live add flow uses the signed-in user’s Firestore `country` (via `getUserProfile` in `add.js`), not `WATCH_REGION`, when calling the Netlify function.

---

## Section 2: Architecture Overview

**Browser (client-side)**  
- **Watchlist UI — React + Vite:** Root **`index.html`** loads **`#root`** and **`/src/main.jsx`**. **`npm run dev:react`** / **`npm run build:react`**; Netlify publishes **`dist/`** from **`npm run build:react`** (`netlify.toml`). **`firebase.js`** (CDN SDK) initializes App, Auth, Firestore, optional Analytics; list CRUD uses the same module. **`src/store/useAppStore.js`** (Zustand) + **`src/store/watchlistConstants.js`** (status labels, SVG snippets). **`src/hooks/useWatchlist.js`** (TanStack Query) loads lists; **`useAuthUser.js`** → **`onAuthStateChanged`**. **`WatchlistPage.jsx`**: **`ListSelector`**, **`WatchlistToolbar`**, **`ManageListsModal`**, auth menu, **`CountryModal`**, **`src/components/modals/*.jsx`** (e.g. **`ListNameModal`**, **`SharedCreatedModal`**, **`DeleteConfirmModal`**), **`UpcomingAlertsBar`**, filters, **`TitleGrid`** / **`TitleCard`**, **`TrailerModal`** (incl. **`src/lib/listsContainingMovie.js`**). Session restore **`useWatchlistSessionRestore.js`**; **`src/lib/watchlistFilters.js`**, **`titleListActions.js`**, **`listModeDisplay.js`**, **`bookmarkletCookie.js`**, **`storage.js`**, **`movieDisplay.js`**, **`utils.js`**. **`src/main.jsx`** warns if **`#root`** is missing.
- All routine Firestore access uses the **signed-in user’s** Firebase session and **`firestore.rules`**.  
- **`add.html`** + **`add.js`** — bookmarklet popup: auth, POST **`/.netlify/functions/add-from-imdb`**, `postMessage` handshake.  
- **`bookmarklet.js`** on **imdb.com** opens hosted **`add.html`**. Production origin is hardcoded in **`bookmarklet.js`** (see file).

**Netlify**  
- **Static hosting** for HTML, CSS, JS, SVG assets.  
- **Serverless functions** (see `netlify.toml` → `functions = "netlify/functions"`):  
  - `add-from-imdb.js` — verifies token, calls OMDb/TMDB, writes Firestore via Admin SDK; after a successful add with `tmdbId`, runs **upcoming alerts** sync for that title (`lib/sync-upcoming-alerts.js`).  
  - `join-shared-list.js` — verifies token, adds caller’s uid to `sharedLists/{listId}.members`.  
  - `check-upcoming.js` — **scheduled** (3:00 UTC, `netlify.toml` → `[functions."check-upcoming"]`): runs chunked sync (`runRegistrySyncWithTimeBudget`) over **`titleRegistry`**, writes to `upcomingAlerts`, `upcomingChecks`, and `syncState/upcomingAlerts`, and writes latest run status to `meta/jobConfig`. Uses shared logic in **`lib/execute-upcoming-sync.js`** and respects `meta/jobConfig.checkUpcomingEnabled` for scheduled runs (manual runs still proceed).  
  - `trigger-upcoming-sync.js` — **HTTP** (GET/POST) manual trigger for the same upcoming sync as `check-upcoming` (preferred over curling the scheduled function URL). Optional env **`UPCOMING_SYNC_TRIGGER_SECRET`** + `Authorization: Bearer …`.  
- Functions use **Firebase Admin** with `FIREBASE_SERVICE_ACCOUNT`; they bypass Firestore security rules by design.
- **`netlify/functions/package.json`** sets `"type": "commonjs"` so handlers stay CommonJS while the repo root `package.json` is `"type": "module"`.

**Firebase**  
- **Authentication:** Google provider; users identified by `uid`.  
- **Firestore:** Collections documented in Section 3. Rules in `firestore.rules`: **`titleRegistry` read for signed-in users, no client writes**; `users/{uid}` and `users/{uid}/personalLists/*` scoped to owner; `sharedLists` readable/writable only by members (with create requiring creator in `members`); `upcomingAlerts` read for any signed-in user, no client writes; `syncState` denied to clients. Collections not explicitly matched (for example `upcomingChecks`, `meta`) are also denied to clients by default. (Legacy **`catalog`** is removed from rules; delete leftover docs with `scripts/delete-legacy-catalog.mjs`.)

**External APIs — where invoked**  
- **TMDB / OMDb:** from **`netlify/functions/add-from-imdb.js`** (POST) and from **local Node scripts**, not from the deployed watchlist client.  
- **YouTube:** browser loads embed URLs; no YouTube Data API key in repo.  
- **No** TMDB calls from the watchlist UI for watch providers or enrichment at runtime; chips use data already on each item (`services`, `servicesByRegion`).

---

## Section 3: Data Model

### `catalog` (**removed**)

Legacy collection is **not** used by the app or scripts anymore. **Rules** no longer include `catalog`. Remove any remaining documents with `node scripts/delete-legacy-catalog.mjs --write` (after backup).

---

### `titleRegistry` / `{registryId}`

Canonical metadata per title (one doc per stable id). **Writes:** Admin SDK only (`add-from-imdb`, migration scripts). **Reads:** Any signed-in user.

| Field | Type | Notes |
|-------|------|--------|
| (same as former embedded item) | | `title`, `year`, `type`, `genre`, `thumb`, `youtubeId`, `imdbId`, `tmdbId`, `tmdbMedia`, `services`, … |

**`registryId` algorithm:** `lib/registry-id.js` — prefer normalized IMDb id (`tt…`), else `tmdb-tv-{id}` / `tmdb-movie-{id}`, else deterministic `legacy-{hash}` from `title|year`.

**List rows** in `users` / `sharedLists` / `personalLists` store **`{ registryId: "<id>" }`** only (after migration). Status arrays use the same string as the key (`registryId`). Per-user display overrides can attach here or on list rows in a future version.

---

### `users` / `{uid}`

| Field | Type | Notes |
|-------|------|--------|
| `defaultPersonalListId` | `string` | Firestore id of the **default** personal list doc under `users/{uid}/personalLists/{id}`. Set when the user names their main list or when legacy data is migrated. |
| `country` | `string` | ISO 3166-1 alpha-2 (e.g. `"IL"`) for TMDB watch region when adding titles. |
| `countryName` | `string` | Human-readable country name for UI. |
| `upcomingDismissals` | `map` | Optional. Keys = alert **fingerprints** (e.g. `136311_3_9`, `12345_sequel_999`); values = ISO date string when the user dismissed that pill. Used so dismissed upcoming notifications stay hidden until a new fingerprint appears. |

**Legacy (removed after migration):** `items`, `watched`, `maybeLater`, `archive`, `listName` on the user root doc were moved into the default `personalLists` subdoc. The client and `add-from-imdb` run a one-time migration; optional bulk script: `scripts/migrate-personal-items-to-subcollection.mjs`.

**Relationship:** Parent for subcollection `personalLists`. Referenced by `sharedLists.members` and `sharedLists.ownerId`.

**Queries / access:** `doc(db, "users", uid)` get/set; no compound queries on `users` in client code beyond single-doc read.

---

### `users` / `{uid}` / `personalLists` / `{listId}`

| Field | Type | Notes |
|-------|------|--------|
| `name` | `string` | **Required** non-empty when creating a subcollection list; stored trimmed. |
| `items` | `array` | Same **Item object** shape as **`sharedLists`** rows (`{ registryId }` after migration). |
| `watched`, `maybeLater`, `archive` | `array` of string | Status keys, same pattern as `sharedLists`. |
| `createdAt` | `string` (ISO) | Set on create. |

**Relationship:** All personal list **content** lives here (including the default list). The app uses virtual `listId === "personal"` for the list whose real id is `users/{uid}.defaultPersonalListId`.

---

### `sharedLists` / `{listId}`

| Field | Type | Notes |
|-------|------|--------|
| `name` | `string` | **Required** non-empty when creating; `join-shared-list` rejects new joins if missing (legacy lists without a name must be renamed in-app first). |
| `ownerId` | `string` | Firebase `uid` of creator. |
| `members` | `array` of string | Uids with access; creator included on create. |
| `items` | `array` | **Item objects** (no `status` stored in Firestore; status derived from key sets). |
| `watched`, `maybeLater`, `archive` | `array` of string | Same pattern as user doc. |
| `createdAt` | `string` (ISO) | |

**Relationship:** Many-to-many via `members` (users can be in multiple lists).

**Indexed / queried:** Client uses `query(collection(db, "sharedLists"), where("members", "array-contains", uid))` in `getSharedListsForUser`. **No `firestore.indexes.json`** is present in repo; Firebase may auto-index simple `array-contains` queries or prompt in console if needed.

---

### `syncState` / `upcomingAlerts` (single doc)

**Writes:** Admin SDK only. Holds **`lastRegistryDocId`** (cursor into `titleRegistry` ordered by document id), **`registryDocCount`** (from Firestore `count()` — invalidates cursor when the registry size changes), **`lastPruneAt`**, and timestamps so `check-upcoming` can sync in **multiple Netlify invocations** (each capped at ~30s). Legacy **`nextIndex`** may still exist in old docs until the next sync clears it. Clients cannot read or write (`firestore.rules`).

### `upcomingChecks` / `{tmdbId_media}`

Admin-only per-title state used by upcoming sync skip logic.

| Field | Type | Notes |
|-------|------|--------|
| `tmdbId` | `number` | TMDB id for the title row. |
| `media` | `"tv"` \| `"movie"` | Media kind used by sync logic. |
| `lastCheckedAt` | `string` (ISO) | Last successful check timestamp. |
| `releaseDate` | `string` or null | Movie release date from TMDB (`YYYY-MM-DD`) when known. |
| `hasCollection` | `boolean` or null | Movie `belongs_to_collection != null` snapshot. |
| `collectionId` | `number` or null | TMDB collection id when present. |
| `updatedAt` | `string` (ISO) | Last state write timestamp. |

### `meta` / `jobConfig`

Admin-only runtime config + status for scheduled jobs.

| Field | Type | Notes |
|-------|------|--------|
| `checkUpcomingEnabled` | `boolean` | Controls whether scheduled `check-upcoming` runs execute or skip. |
| `lastRunAt` | `string` (ISO) | Last run attempt timestamp. |
| `lastRunStatus` | `string` or null | `success`, `error`, or `skipped`. |
| `lastRunMessage` | `string` or null | Human-readable summary/error. |
| `lastRunResult` | `map` or null | Last payload from sync result. |
| `lastRunTrigger` | `string` or null | Trigger source (`POST`, cron header, etc.). |
| `updatedAt` | `string` (ISO) | Last config/status write timestamp. |

### `upcomingAlerts` / `{docId}`

Top-level collection. **Writes:** Admin SDK only (`check-upcoming` scheduled function, `add-from-imdb` single-title sync). **Reads:** Any signed-in user (`firestore.rules`).

Document id examples: `tv_136311_3_9`, `mv_12345_sequel_67890`. Fields include:

| Field | Type | Notes |
|-------|------|--------|
| `catalogTmdbId` | `number` | TMDB id of the catalog row this alert was built from (same as list item after merge). |
| `media` | `"tv"` \| `"movie"` | Matches list classification (`show` → tv). |
| `fingerprint` | `string` | Dismissal / identity key (e.g. `136311_3_9`, `12345_sequel_999`, `12345_upcoming`). |
| `tmdbId` | `number` | Same as `catalogTmdbId` in current implementation (show in list). |
| `type` | `"tv"` \| `"movie"` | Same as `media`. |
| `alertType` | `string` | `new_episode`, `upcoming_movie`, `sequel`. (Legacy `new_season` / TBA “returning” rows are no longer written.) |
| `title`, `detail` | `string` | UI copy. |
| `airDate` | `string` or null | `YYYY-MM-DD` when known; may be null on very old docs. |
| `confirmed` | `bool` | `true` for newly synced rows (TBA returning alerts are not created). |
| `expiresAt` | `string` | `YYYY-MM-DD`; expired docs deleted by the scheduled job. |
| `sequelTmdbId` | `number` or null | For `sequel` alerts. |
| `detectedAt` | `timestamp` | Server time on upsert. |

**Client:** `firebase.js` → `fetchUpcomingAlertsForItems` (chunks `catalogTmdbId` / `sequelTmdbId` `in` queries), `dismissUpcomingAlert` merges into `users/{uid}.upcomingDismissals`. **`UpcomingAlertsBar.jsx`** shows pills for the **currently loaded list** only, max 3 + expand, sorted by `airDate`. Sync never writes undated/TBA rows; the client drops any alert without a parseable date (legacy junk). Each pill includes **Add to calendar** (all-day **`.ics`**) when `airDate` is a normal `YYYY-MM-DD`.

**Admin queries:** Composite `(catalogTmdbId, media)` may be required for `deleteStaleAlertsForRow`; Firebase console may prompt to create an index on first scheduled run.

---

### List row in Firestore (`items` array)

**Current (normalized):** `{ "registryId": "tt1234567" }` (or `tmdb-tv-…` / `legacy-…`). Metadata lives in **`titleRegistry/{registryId}`**; the client merges on read (`firebase.js` → `hydrateListItemsFromRegistry`).

**Legacy (pre-migration):** full embedded objects with the same fields as **`titleRegistry`** docs; still supported until `scripts/migrate-to-title-registry.mjs` is run.

**Registry / hydrated fields** (from `titleRegistry` or legacy embed):

| Field | Type | Notes |
|-------|------|--------|
| `registryId` | `string` | Present on hydrated client objects; not stored in `titleRegistry` payload (doc id is the id). |
| `title` | `string` | |
| `year` | `number` or null | |
| `type` | `"movie"` \| `"show"` | TV uses `"show"`. |
| `genre` | `string` | Often `"Genre1 / Genre2"`. |
| `thumb` | `string` (URL) or null | TMDB poster or OMDb poster. |
| `youtubeId` | `string` or null | Must match 11-char pattern to be “playable” (`lib/youtube-trailer-id.js`). |
| `imdbId` | `string` | Normalized with `tt` prefix in add flow. |
| `tmdbId` | `number` | When TMDB enrichment succeeds. |
| `services` | `array` of string | Provider display names for a region (legacy / default). |
| `servicesByRegion` | `object` | Optional map `{ "IL": [...], ... }`; may be populated by maintenance scripts or future client code (not written by current SPA). |
| `tmdbMedia` | `string` | `"tv"` \| `"movie"` for TMDB dedupe / upcoming sync. |

**Runtime-only:** `status` (`to-watch` \| `watched` \| `maybe-later` \| `archive`) is **computed in memory** when loading lists, from `watched` / `maybeLater` / `archive` key arrays (`listKey` / `registryId`).

---

## Section 4: User Flows

### 1. Sign in flow

1. User opens the site (**deployed `dist/` from Netlify**, or **`npm run dev:react`** locally).  
2. User clicks “Sign in with Google”.  
3. **`src/App.jsx`** calls `signInWithPopup(auth, GoogleAuthProvider)` (custom parameter `prompt: "select_account"`). Firebase Auth sessions are **per origin** (host + port); local dev on a different port than production is a separate session. **`auth/unauthorized-domain`** is handled in UI (add the host in Firebase Console → Authentication → Authorized domains).  
4. Firebase Auth completes Google OAuth; `onAuthStateChanged` fires with a user.  
5. **`WatchlistPage`** loads profile / lists via React Query and **`useWatchlistSessionRestore`** (`/join/:listId` plus legacy `?join=` redirect, last list, filter prefs from **`storage.js`**).  
6. List data: `getPersonalListMovies` / `getSharedListMovies` via **`firebase.js`**.  
7. **`TitleGrid`** / **`TitleCard`** render the grid; filters persisted per uid in **`localStorage`**.

### 2. Add title via IMDb bookmarklet flow

1. User drags bookmarklet from `bookmarklet.html` (bookmark is a `javascript:` URL that injects `bookmarklet.js` from the deployed origin).  
2. On an IMDb title page, user runs bookmarklet: validates pathname `/title/ttxxxx`.  
3. Script opens popup to `{site}/add.html?imdbId=...&embed=1` (production URL hardcoded in `bookmarklet.js`).  
4. `add.js` validates IMDb id; subscribes to `onAuthStateChanged`.  
5. If not signed in: show error; `postMessage` to parent/opener; optionally close popup.  
6. If signed in: read `getUserProfile` for `watch_region`; read optional `listId` from cookie `bookmarklet_list_id` (shared list) and optional `personalListId` from cookie `bookmarklet_personal_list_id` (current personal list’s real subdoc id, set by the main app).  
7. `fetch("/.netlify/functions/add-from-imdb", { POST, Authorization: Bearer <getIdToken()> })` with body `{ imdbId, watch_region, listId?, personalListId? }`.  
8. Netlify function verifies token → `uid`; loads OMDb; if `TMDB_API_KEY` present, runs TMDB find + detail + videos + watch providers; else falls back to OMDb-only row; writes to `sharedLists/{listId}` or `users/{uid}/personalLists/{personalListId}` (default id from profile if cookie absent); migrates legacy `users/{uid}.items` on first write when needed.  
9. Response JSON returned; `add.js` displays message; `postMessage({ type: "add-result", ... })` to opener/parent; bookmarklet shows toast and closes popup.  
10. **Main watchlist tab does not automatically reload** from this flow; user refreshes or revisits to see new titles (unless they were already polling — they are not).

**Upcoming alerts sync (separate from bookmarklet):** Manual HTTP / `curl` should call `/.netlify/functions/trigger-upcoming-sync` (GET/POST), not the scheduled `check-upcoming` URL (often fails fast on Netlify). Both use `runRegistrySyncWithTimeBudget`.

### 3. TMDB enrichment flow (add path)

**Implemented in** `netlify/functions/add-from-imdb.js` (POST) and conceptually:

1. Normalize IMDb id to `tt…`.  
2. Fetch OMDb by id (for type hint and fallback body).  
3. If `TMDB_API_KEY` set: **find** `/find/{imdb_id}?external_source=imdb_id`.  
4. Choose movie vs TV via `pickTmdbFindEntry` (OMDb `Type`, else prefer TV if both exist).  
5. **Detail** `/{movie|tv}/{id}?append_to_response=videos` → poster, title, year, genres, `videos.results`.  
6. Pick YouTube key: prefer Trailer → Teaser → Clip/Featurette → any YouTube on TMDB.  
7. If watch region present (2-letter): **watch providers** `/{type}/{id}/watch/providers`, flatten `flatrate`/`rent`/`buy` names for that region.  
8. If TMDB fails: build minimal row from OMDb only (`youtubeId: null`).  
9. Dedupe/merge into target list document; normalize `youtubeId` through 11-char validation before persist.

### 4. Shared list invite flow

**Create:**  
1. Signed-in user opens list settings modal → “Create shared list”, enters name.  
2. `createSharedList(uid, name)` writes `sharedLists/{listId}` with `ownerId`, `members: [uid]`, empty arrays.  
3. Modal shows URL `/join/{listId}` and copy button.

**Join via link:**  
1. User opens site with `/join/{listId}` while signed in (legacy `?join=` links are redirected).
2. Client `POST`s `/.netlify/functions/join-shared-list` with JSON `{ listId }`, `credentials: "include"` — **`useWatchlistSessionRestore.ts`** (legacy query redirect on load) or **`ManageListsModal.tsx`** (paste URL). Function reads Firebase ID token from cookie and/or `Authorization` header.
3. Function verifies Firebase ID token, `arrayUnion(uid)` on `members` if not already present (fails with **400** if the list document has no non-empty `name` and the user was not already a member).  
4. Client refreshes shared lists, switches `currentListMode` to that shared list.

**Join via paste:**  
- Lists modal “Join” reads URL from input, extracts `join` query param, same POST as above.

**Copy invite (header):**  
- When viewing a shared list, “Copy invite link” copies `/join/{listId}`.

### 5. Watch provider lookup flow

1. **At add time:** User’s `country` on `users/{uid}` is read in `add.js` as `watch_region` and sent to `add-from-imdb`.  
2. **Server:** `enrichFromTmdb` fetches TMDB watch providers for that region and stores provider **names** on the new/merged item as `services` (array of strings).  
3. **At display time:** **`servicesForMovie(m, userCountryCode)`** in **`src/lib/movieDisplay.js`** (used by **`TitleCard`** / **`TrailerModal`**) prefers `m.servicesByRegion[countryCode]`, else `m.services`.  
4. **Persisting region-specific cache:** no watchlist client helper; `services` / `servicesByRegion` are set at add time (Netlify) or by scripts.

---

## Section 5: Component Map

| Name / file | Responsibility | Reads Firestore | Writes Firestore | External APIs |
|-------------|----------------|-----------------|------------------|---------------|
| `index.html` / `src/main.jsx` | Vite entry; mounts React (`App` → `WatchlistPage`). | — | — | Google Fonts (from HTML) |
| `src/components/*.jsx`, `src/components/modals/*.jsx`, `src/hooks/*` | React watchlist UI (see Architecture). | Via `firebase.js` | Via `firebase.js` | `fetch` → `join-shared-list` where used; YouTube embeds; clipboard |
| `src/store/watchlistConstants.js` | Status labels, checkmark/upcoming SVG snippets, `GENRE_LIMIT`. | — | — | — |
| `src/lib/movieDisplay.js` | `servicesForMovie`, `renderServiceChips`, `hasPlayableTrailerYoutubeId`. | — | — | — |
| `src/config/firebase.ts` | Firebase Web SDK config from `import.meta.env` (`VITE_FIREBASE_*`) with normalization/sanitization and safe defaults. | — | — | — |
| `firebase.js` | Imports config, initializes App/Auth/Firestore, optional Analytics (`getAnalytics(app)` when allowed — not exported); **`titleRegistry`** hydration, user/shared/personal list CRUD, status keys. | `titleRegistry`, `users/*`, `sharedLists/*`, `personalLists/*` | Same | Firebase SDK only (Gstatic CDN) |
| `countries.js` | Static ISO country list + flags for country modal. | — | — | — |
| `lib/youtube-trailer-id.js` | Validate/normalize TMDB YouTube key strings. | — | — | — |
| `add.html` | Minimal page for add result. | — | — | — |
| `add.js` | Bookmarklet target: auth gate, call add function. | `getUserProfile` | — | `fetch` → `add-from-imdb` |
| `bookmarklet.html` | Instructions + draggable bookmark. | — | — | — |
| `bookmarklet.js` | On IMDb: open popup, `postMessage` handshake. | — | — | Opens hosted `add.html` (hardcoded Netlify host) |
| `netlify/functions/add-from-imdb.js` | Auth verify, OMDb/TMDB enrichment, merge/write list docs. | Firestore via Admin | `users`, `sharedLists` | OMDb, TMDB |
| `netlify/functions/join-shared-list.js` | Add member to shared list. | Firestore via Admin | `sharedLists` | — |
| `styles.css` | Visual styling. | — | — | — |
| `check-upcoming.mjs` | Local diagnostic: read Firestore + TMDB, print report. | Admin + `dotenv` | — | TMDB |
| `compare-upcoming-trakt.mjs` | Optional read-only compare: TMDB vs Trakt “next episode” (same Firestore sources as `check-upcoming.mjs`). | Admin + `dotenv` | — | Trakt, TMDB |
| `scripts/*.js`, `scripts/*.mjs`, `scripts/lib/*` | Maintenance, backup, migration (titleRegistry model). | Admin (typical) | Varies | TMDB, OMDb, etc. |

---

## Section 6: Mermaid Diagrams

### System context (context diagram)

```mermaid
flowchart LR
  subgraph Browser["Browser (user)"]
    SPA["Watchlist UI (React dist / Vite dev)"]
    ADD["add.html + add.js"]
    BM["bookmarklet on imdb.com"]
  end

  subgraph Netlify["Netlify"]
    NF1["add-from-imdb"]
    NF2["join-shared-list"]
    NF3["check-upcoming (scheduled)"]
    NF4["trigger-upcoming-sync (HTTP)"]
    Static["Static assets"]
  end

  subgraph Firebase["Firebase"]
    FS["Firestore"]
    FA["Auth"]
  end

  subgraph External["External APIs"]
    TMDB["TMDB API"]
    OMDb["OMDb API"]
    YT["YouTube embeds"]
    GFonts["Google Fonts"]
    Gstatic["Google gstatic (Firebase SDK)"]
  end

  SPA --> Gstatic
  SPA --> FA
  SPA --> FS
  ADD --> FA
  ADD --> NF1
  BM --> ADD
  BM --> Static
  SPA --> Static
  ADD --> Static

  NF1 --> FS
  NF1 --> FA
  NF1 --> TMDB
  NF1 --> OMDb
  NF2 --> FS
  NF2 --> FA
  NF3 --> FS
  NF3 --> TMDB
  NF4 --> FS
  NF4 --> TMDB

  SPA --> YT
```

### IMDb bookmarklet → TMDB enrichment → card (sequence diagram)

```mermaid
sequenceDiagram
  participant User
  participant IMDb as imdb.com
  participant BM as bookmarklet.js
  participant Popup as add.html + add.js
  participant Auth as Firebase Auth
  participant NF as Netlify add-from-imdb
  participant OMDb
  participant TMDB
  participant FS as Firestore

  User->>IMDb: Browse title page
  User->>BM: Run bookmarklet
  BM->>Popup: window.open add.html?imdbId=...&embed=1
  Popup->>Auth: onAuthStateChanged
  Auth-->>Popup: user + getIdToken()
  Popup->>Popup: getUserProfile (country)
  Popup->>NF: POST JSON + Bearer token
  NF->>Auth: verifyIdToken
  NF->>OMDb: GET by imdb id
  NF->>TMDB: find by imdb id
  NF->>TMDB: movie/tv detail + videos
  NF->>TMDB: watch/providers (region)
  NF->>FS: update users/uid or sharedLists/listId
  NF-->>Popup: JSON ok/message
  Popup->>BM: postMessage add-result
  BM-->>User: Toast + close popup

  Note over User,FS: Main tab: user refreshes or revisits index
  User->>SPA: Open / refresh watchlist
  SPA->>FS: getPersonalListMovies / getSharedListMovies
  FS-->>SPA: items with thumb, youtubeId, services...
  SPA-->>User: TitleGrid / list render
```

### Sign in → watchlist load (sequence diagram)

```mermaid
sequenceDiagram
  participant User
  participant App as Watchlist UI
  participant Auth as Firebase Auth Google
  participant FS as Firestore

  User->>App: Click Sign in with Google
  App->>Auth: signInWithPopup(GoogleAuthProvider)
  Auth-->>App: User session
  App->>App: onAuthStateChanged
  App->>FS: getUserProfile(uid)
  FS-->>App: country / countryName
  opt No country set
    App->>User: Country modal
    App->>FS: setUserCountry
  end
  App->>FS: getSharedListsForUser (array-contains members)
  App->>FS: getPersonalLists
  App->>FS: getPersonalListMovies or getSharedListMovies
  FS-A->>FS: getDoc titleRegistry/* (hydrate list rows)
  FS-->>App: items + status keys applied in memory
  App->>User: Grid + filters UI
```

### Firestore ER (entity relationship)

**Note:** List **content** (`items`, status arrays) lives on **`personalLists`** and **`sharedLists`** docs only. The **`users/{uid}`** doc holds profile + **`defaultPersonalListId`** + dismissals; legacy root-level `items` / `listName` were migrated into the default personal list (Section 3). **`catalog`** was removed (Section 3).

```mermaid
erDiagram
  USER_DOC ||--o{ PERSONAL_LIST : "users/uid/personalLists"
  USER_DOC {
    string uid PK "document id"
    string defaultPersonalListId
    string country
    string countryName
  }
  PERSONAL_LIST {
    string listId PK
    string name
    array items
    array watched
    array maybeLater
    array archive
    string createdAt
  }
  SHARED_LIST {
    string listId PK
    string name
    string ownerId FK "users uid"
    array members "user uids"
    array items
    array watched
    array maybeLater
    array archive
    string createdAt
  }
  USER_DOC }o--o{ SHARED_LIST : "uid in members"
  TITLE_REGISTRY {
    string registryId PK
    string title
    number tmdbId
  }
  PERSONAL_LIST }o--o{ TITLE_REGISTRY : "items[].registryId"
  SHARED_LIST }o--o{ TITLE_REGISTRY : "items[].registryId"
```

### TMDB enrichment decision logic (flowchart)

```mermaid
flowchart TD
  A[POST add-from-imdb with imdbId] --> B{Verify Firebase token}
  B -->|invalid| X401[401 error]
  B -->|ok| C[Fetch OMDb by imdbId]
  C --> D{TMDB_API_KEY set?}
  D -->|no| OMDbOnly[Build row from OMDb only youtubeId null]
  D -->|yes| E[TMDB find external_source imdb_id]
  E --> F{movie_results or tv_results?}
  F -->|none| G{OMDb ok?}
  G -->|no| ERR[502 / error]
  G -->|yes| OMDbOnly
  F -->|one or both| H[pickTmdbFindEntry OMDb Type or prefer TV]
  H --> I[GET detail append_to_response videos]
  I --> J[pickYoutubeTrailerKey from videos.results]
  I --> K[GET watch/providers for region if 2-letter region]
  K --> L[Assemble movie row tmdbId thumb genre services]
  J --> L
  L --> M[listId cookie/body target shared list?]
  M -->|yes| N{uid in members?}
  N -->|no| X403[403]
  N -->|yes| P[Dedupe by imdb or title+year append items]
  M -->|no| Q[personalLists doc under users/uid — merge or append items]
  OMDbOnly --> Q
  P --> R[200 success]
  Q --> R
```

---

## Section 7: Open Questions & Gaps

1. **Web app config:** Firebase web SDK settings are read from `VITE_FIREBASE_*` (`src/config/firebase.ts`) at build/runtime via Vite env loading.

2. **Secrets in repository:** Firebase client config is no longer hardcoded in source; keep real values in `.env.local` (gitignored) and in Netlify environment variables. `FIREBASE_SERVICE_ACCOUNT` stays out of git.

3. **Bookmarklet portability:** `bookmarklet.js` and `bookmarklet.html` hardcode **`https://watchlist-trailers.netlify.app`** for the script URL and popup base. Forks or alternate deployments must edit these files.

4. **Bookmarklet target lists:** Cookie `bookmarklet_list_id` selects a **shared** list. Cookie `bookmarklet_personal_list_id` holds the Firestore id of the **currently viewed personal list** (default or extra subdoc); `add-from-imdb` writes to that `users/{uid}/personalLists/{id}` document.

5. **Firestore rules vs Admin:** Client rules deny **`titleRegistry`** writes; list mutations from functions use **Admin SDK** (bypass rules). Compromise of `FIREBASE_SERVICE_ACCOUNT` on Netlify is full database access.

6. **Shared list join token:** Join uses the same `bookmarklet_token` cookie / Bearer token as add; there is **no separate invite secret** — anyone with a valid account and a `listId` could join if they guess/obtain the id (predictability of random ids should be considered).

7. **`join-shared-list` CORS headers:** Response includes `Access-Control-Allow-Origin` reflecting request origin; **POST from browser** with credentials is how the watchlist client calls it; behavior depends on Netlify origin alignment.

8. **Composite indexes:** `array-contains` query on `sharedLists` has **no committed `firestore.indexes.json`**; if Firebase ever requires a composite index for an expanded query, it would be created in console only.

9. **“Recently Added” tab:** Driven by **order of items in the loaded array** (last N in array), not a server-side `addedAt` field — reordering or merge logic can change meaning without a timestamp.

10. **`firebase.js` public surface:** The module intentionally keeps Firestore **`db`** and Analytics instances **internal** (not re-exported). Call sites use the named helpers (`getPersonalListMovies`, etc.).

---

*End of document.*
