# System Design Document

This document describes **only what exists in this repository** (static site, Vercel **`api/*`** serverless routes, Firestore rules, Firebase client module, and operational scripts). It does not specify future or assumed behavior.

---

## Section 1: Services & External Dependencies

| Service name | Purpose | How it's accessed | Authentication | Environment variables |
|--------------|---------|-------------------|----------------|----------------------|
| **Firebase (Firestore)** | Persist watchlists, shared lists, **`titleRegistry`**, **`phoneIndex`**, **`verificationCodes`**, user profile (country, list name, linked phone ids). | **Client:** Firebase JS SDK v10 in `src/firebase.ts` (`getFirestore`, `doc`, `getDoc`, `setDoc`, etc.), bundled by Vite. **Server:** `firebase-admin` in **`api/*`** routes and Node scripts. | **Client:** Firebase Auth user JWT (SDK attaches to requests per Firestore rules). **Server:** Service account JSON (base64) for Admin SDK. | **Client:** `VITE_FIREBASE_*` variables (read in `src/config/firebase.ts` via `import.meta.env`). **Server/scripts:** `FIREBASE_SERVICE_ACCOUNT` (base64 JSON). Scripts may also use `serviceAccountKey.json` in project root (per README / `check-upcoming.mjs`). |
| **Firebase Auth** | Google Sign-In for end users. | **Client:** Firebase Auth SDK from npm (`signInWithPopup`, `GoogleAuthProvider`, `onAuthStateChanged`) in `src/firebase.ts` (bundled by Vite; not a CDN script tag). | OAuth via Google; Firebase-issued ID tokens. | Same Firebase client env vars (`VITE_FIREBASE_*`). |
| **Firebase Analytics** | Optional; skipped when **offline**, in **Vite dev** (`import.meta.env.DEV`), or when blocked. | **Client:** `src/firebase.ts` dynamically imports Analytics only if `shouldLoadWebAnalytics()` passes, then `isSupported()` + `getAnalytics(app)` (avoids Installations `app-offline` noise locally). | Inherits Firebase web app setup. | Uses the same `VITE_FIREBASE_*` values. |
| **The Movie Database (TMDB)** | Resolve IMDb id → TMDB id; poster; genres/year; **YouTube trailer key** from appended `videos`; **watch providers** by region. | **REST:** `https://api.themoviedb.org/3/...` via Node `https.get` in `api/add-from-imdb.js`. Same pattern in maintenance scripts (e.g. `scripts/sync-services-from-tmdb.js`, `check-upcoming.mjs` uses `fetch`). **Not** called from the browser watchlist UI. | API key query parameter `api_key`. | `TMDB_API_KEY` in Vercel env / `.env` for local scripts / `check-upcoming.mjs`. |
| **OMDb** | Title metadata by IMDb id; disambiguate movie vs TV when TMDB returns both; fallback row when TMDB has no match. | **REST:** `https://www.omdbapi.com/?i=...&apikey=...` in `add-from-imdb.js` and various scripts. | API key query parameter. | `OMDB_API_KEY` (Vercel + local scripts per README / `.env.example`). |
| **YouTube** | Trailer playback in modal via iframe embed. | **Browser:** `https://www.youtube-nocookie.com/embed/{youtubeId}?...` and link to `youtube.com/watch`. | None for embed (public video ids). | None. |
| **Google Fonts** | UI typography (Bebas Neue, DM Sans). | `<link href="https://fonts.googleapis.com/...">` in HTML. | None. | None. |
| **Vercel** | Host static HTML/CSS/JS from **`dist/`**; run Node serverless routes under **`/api/*`** (`api/*.js`, **`vercel.json`**). | **Browser:** `fetch` to same-origin **`/api/...`** (e.g. **`log-client-event`** for Axiom ingest with `Authorization: Bearer` ID token). **Server:** CommonJS handlers wrapped by **`src/api-lib/vercel-adapter.js`** for `(req, res)`. | Routes verify Firebase ID token (cookie or `Authorization: Bearer`) where needed. | `FIREBASE_SERVICE_ACCOUNT`, `OMDB_API_KEY`, `TMDB_API_KEY`, optional `UPCOMING_SYNC_TRIGGER_SECRET`, optional `AXIOM_TOKEN`, optional `AXIOM_DATASET`, optional **`WHATSAPP_VERIFY_TOKEN`**, **`WHATSAPP_TOKEN`**, **`WHATSAPP_PHONE_NUMBER_ID`**, optional **`APP_PUBLIC_URL`** / **`VITE_APP_ORIGIN`** for outbound message copy (server-only; no `VITE_AXIOM_*`). |
| **Meta (WhatsApp Cloud API)** | Webhook verification (GET) and inbound text (POST); outbound text replies after verify/add flows. | **Server:** **`api/whatsapp-webhook.js`** (Meta → app), **`api/whatsapp-verify.js`** and **`src/api-lib/whatsapp-graph.js`** (Graph `messages` API). **Not** called from the browser. | **`WHATSAPP_VERIFY_TOKEN`** must match Meta’s verify field; **`WHATSAPP_TOKEN`** + **`WHATSAPP_PHONE_NUMBER_ID`** for sending. | Same WhatsApp env vars as above. |

**Note:** `.env` is for server/script vars (`process.env`) and `.env.local` is for client Vite vars (`import.meta.env`). The live add flow uses the signed-in user’s Firestore `country` (via `getUserProfile` in `src/add-main.ts`), not `WATCH_REGION`, when calling **`/api/add-from-imdb`**. For Vercel vs Vite variable placement and sensitive keys, see **[`docs/environment.md`](./docs/environment.md)**.

---

## Section 2: Architecture Overview

**Browser (client-side)**  
- **Watchlist UI — React + TypeScript + Vite:** Root **`index.html`** loads **`#root`** and **`/src/main.tsx`**. **`npm run dev:react`** / **`npm run build:react`**; Vercel publishes **`dist/`** from **`npm run build:react`** (**`vercel.json`**). **`src/firebase.ts`** (Firebase JS SDK from npm, bundled by Vite) initializes App, Auth, Firestore, optional Analytics; list CRUD uses the same module. **`src/store/useAppStore.ts`** (Zustand) + **`src/store/watchlistConstants.ts`**. **`src/hooks/useWatchlist.ts`** (TanStack Query) loads lists; **`useAuthUser.ts`** → **`onAuthStateChanged`**. **`WatchlistPage.tsx`**: **`ListSelector`**, **`WatchlistToolbar`**, **`ManageListsModal`**, auth menu (**WhatsApp** → **`WhatsAppSettings`**), **`CountryModal`**, **`src/components/modals/*.tsx`**, **`UpcomingAlertsBar`**, filters, **`TitleGrid`** / **`TitleCard`**, **`TrailerModal`**. Session restore **`useWatchlistSessionRestore.ts`**; **`src/lib/watchlistFilters.ts`**, **`bookmarkletCookie.ts`**, **`storage.ts`**, **`movieDisplay.ts`**, **`utils.ts`**, **`src/data/lists.ts`**, **`src/hooks/useMutations.ts`**. **`src/main.tsx`** warns if **`#root`** is missing.
- All routine Firestore access uses the **signed-in user’s** Firebase session and **`firestore.rules`**.  
- **`add.html`** + **`src/add-main.ts`** — bookmarklet popup: auth, POST **`/api/add-from-imdb`**, `postMessage` handshake.  
- **`public/bookmarklet.js`** on **imdb.com** opens hosted **`add.html`**. Production origin is hardcoded in **`public/bookmarklet.js`** (see file); `postMessage` also allows **`localhost`** and legacy Netlify origins for dev.

**Vercel (`api/*`)**  
- **Static hosting** for HTML, CSS, JS, SVG assets from **`dist/`**.  
- **Serverless API routes** (root **`api/*.js`**, **`vercel.json`** rewrites + cron **`/api/check-upcoming`**):  
  - `add-from-imdb.js` — verifies token, calls OMDb/TMDB, writes Firestore via Admin SDK; after a successful add with `tmdbId`, runs **upcoming alerts** sync for that title (`src/api-lib/sync-upcoming-alerts.js`).  
  - `join-shared-list.js` — verifies token, adds caller’s uid to `sharedLists/{listId}.members`.  
  - `check-upcoming.js` — **cron** (3:00 UTC, **`vercel.json`**): runs chunked sync (`runRegistrySyncWithTimeBudget`) over **`titleRegistry`**, writes to `upcomingAlerts`, `upcomingChecks`, and `syncState/upcomingAlerts`, and writes latest run status to `meta/jobConfig`. Uses shared logic in **`src/api-lib/execute-upcoming-sync.js`** and respects `meta/jobConfig.checkUpcomingEnabled` for scheduled runs (manual runs still proceed). Recognizes **`x-vercel-cron`** like Netlify’s **`x-netlify-event`**.  
  - `trigger-upcoming-sync.js` — **HTTP** (GET/POST) manual trigger for the same upcoming sync as `check-upcoming`. Optional env **`UPCOMING_SYNC_TRIGGER_SECRET`** + `Authorization: Bearer …`.  
  - `log-client-event.js` — POST authenticated client events to **Axiom** (server-only `AXIOM_*`).  
  - `admin-job-config.js` — GET/POST **`meta/jobConfig`** (toggle scheduled upcoming job, read last run).  
  - `admin-env-status.js` — GET boolean flags for which server env keys are set (diagnostics; no secret values returned).  
  - `github-backup-status.js` — Admin: latest GitHub Actions run for the Firestore backup workflow (optional `GITHUB_TOKEN`).  
  - `whatsapp-webhook.js` — **GET:** Meta subscription verification (`hub.verify_token` vs `WHATSAPP_VERIFY_TOKEN`). **POST:** parse inbound text, extract IMDb id; if sender maps in **`phoneIndex`**, call shared **`add-from-imdb`** logic as that user + default list; reply via Graph API; always **200** on POST to limit Meta retries.  
  - `whatsapp-verify.js` — **POST** + Firebase ID token: send or verify **6-digit** link code, write **`phoneIndex`** and **`users.phoneNumbers`** via Admin SDK; uses **`verificationCodes`** and **`src/api-lib/phone-index.js`**.    
- Routes use **Firebase Admin** with `FIREBASE_SERVICE_ACCOUNT` where needed; they bypass Firestore security rules by design.
- **`api/package.json`** sets `"type": "commonjs"` so handlers stay CommonJS while the repo root `package.json` is `"type": "module"`.

**Firebase**  
- **Authentication:** Google provider; users identified by `uid`.  
- **Firestore:** Collections documented in Section 3. Rules in `firestore.rules`: **`titleRegistry` read for signed-in users, no client writes**; `users/{uid}` and `users/{uid}/personalLists/*` scoped to owner; `sharedLists` readable/writable only by members (with create requiring creator in `members`); `upcomingAlerts` read for any signed-in user, no client writes; `syncState` and **`verificationCodes`** denied to clients; **`phoneIndex`** readable/writable only when **`resource` / `request` `uid` matches** the signed-in user (owner-scoped rows). Collections not explicitly matched (for example `upcomingChecks`, `meta`) are also denied to clients by default. (Legacy **`catalog`** is removed from rules; delete leftover docs with `scripts/delete-legacy-catalog.mjs`.)

**External APIs — where invoked**  
- **TMDB / OMDb:** from **`api/add-from-imdb.js`** (POST) and from **local Node scripts**, not from the deployed watchlist client.  
- **Meta WhatsApp:** from **`api/whatsapp-webhook.js`** and **`api/whatsapp-verify.js`** (server only).  
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

**`registryId` algorithm:** **`src/lib/registry-id.ts`** (client) / **`src/api-lib/registry-id.cjs`** (functions) — prefer normalized IMDb id (`tt…`), else `tmdb-tv-{id}` / `tmdb-movie-{id}`, else deterministic `legacy-{hash}` from `title|year`.

**List rows** in `users` / `sharedLists` / `personalLists` store **`{ registryId: "<id>" }`** only (after migration). Status arrays use the same string as the key (`registryId`). Per-user display overrides can attach here or on list rows in a future version.

---

### `users` / `{uid}`

| Field | Type | Notes |
|-------|------|--------|
| `defaultPersonalListId` | `string` | Firestore id of the **default** personal list doc under `users/{uid}/personalLists/{id}`. Set when the user names their main list or when legacy data is migrated. |
| `country` | `string` | ISO 3166-1 alpha-2 (e.g. `"IL"`) for TMDB watch region when adding titles. |
| `countryName` | `string` | Human-readable country name for UI. |
| `upcomingDismissals` | `map` | Optional. Keys = alert **fingerprints** (e.g. `136311_3_9`, `12345_sequel_999`); values = ISO date string when the user dismissed that pill. Used so dismissed upcoming notifications stay hidden until a new fingerprint appears. |
| `phoneNumbers` | `array` of string | Optional. **Digits-only** ids (same as **`phoneIndex`** document ids) for WhatsApp-linked numbers; maintained with **`arrayUnion` / `arrayRemove`** when linking or removing in **`WhatsAppSettings`**. |

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

**Writes:** Admin SDK only. Holds **`lastRegistryDocId`** (cursor into `titleRegistry` ordered by document id), **`registryDocCount`** (from Firestore `count()` — invalidates cursor when the registry size changes), **`lastPruneAt`**, and timestamps so `check-upcoming` can sync in **multiple short serverless invocations** (each capped by host limits; **`vercel.json`** sets **60s** for heavy routes). Legacy **`nextIndex`** may still exist in old docs until the next sync clears it. Clients cannot read or write (`firestore.rules`).

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

**Client:** `src/firebase.ts` → `fetchUpcomingAlertsForItems` (chunks `catalogTmdbId` / `sequelTmdbId` `in` queries), `dismissUpcomingAlert` merges into `users/{uid}.upcomingDismissals`. **`UpcomingAlertsBar.tsx`** shows pills for the **currently loaded list** only, max 3 + expand, sorted by `airDate`. Sync never writes undated/TBA rows; the client drops any alert without a parseable date (legacy junk). Each pill includes **Add to calendar** (all-day **`.ics`**) when `airDate` is a normal `YYYY-MM-DD`.

**Admin queries:** Composite `(catalogTmdbId, media)` may be required for `deleteStaleAlertsForRow`; Firebase console may prompt to create an index on first scheduled run.

---

### List row in Firestore (`items` array)

**Current (normalized):** `{ "registryId": "tt1234567" }` (or `tmdb-tv-…` / `legacy-…`). Metadata lives in **`titleRegistry/{registryId}`**; the client merges on read (`src/firebase.ts` → `hydrateListItemsFromRegistry`). List rows persist **`addedAt`** (ISO string) when writing via `rowToStore` / `ensureAddedAt`.

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
| `youtubeId` | `string` or null | Must match 11-char pattern to be “playable” (`src/lib/youtube-trailer-id.ts`). |
| `imdbId` | `string` | Normalized with `tt` prefix in add flow. |
| `tmdbId` | `number` | When TMDB enrichment succeeds. |
| `services` | `array` of string | Provider display names for a region (legacy / default). |
| `servicesByRegion` | `object` | Optional map `{ "IL": [...], ... }`; may be populated by maintenance scripts or future client code (not written by current SPA). |
| `tmdbMedia` | `string` | `"tv"` \| `"movie"` for TMDB dedupe / upcoming sync. |

**Runtime-only:** `status` (`to-watch` \| `watched` \| `maybe-later` \| `archive`) is **computed in memory** when loading lists, from `watched` / `maybeLater` / `archive` key arrays (`listKey` / `registryId`).

---

### `phoneIndex` / `{digits}`

**Document id:** digits only (no `+`), aligned with WhatsApp Cloud API `from` and **`phoneIndexDocId`** in **`src/api-lib/phone-index.js`**.

**Writes:** Owner via client (**`firebase.ts`**: `addUserPhoneNumber`, `removeUserPhoneNumber`, `setWhatsAppDefaultListForPhone`) when rules allow; Admin SDK in **`whatsapp-verify.js`** during code verification.

**Reads:** Owner only (`firestore.rules`). Server webhook uses Admin SDK to resolve sender → **`uid`** + default list.

| Field | Type | Notes |
|-------|------|--------|
| `uid` | `string` | Firebase user who verified the number. |
| `defaultAddListId` | `string` | Personal list subdoc id or shared list id. |
| `defaultListType` | `"personal"` \| `"shared"` | Which list type **`defaultAddListId`** refers to. |
| `updatedAt` | `string` (ISO) | Last write. |

---

### `verificationCodes` / `{docId}`

**Writes / reads:** Admin SDK only (`whatsapp-verify.js`). Short-lived **6-digit** verification flow for linking a number; clients never touch this collection (rules deny all).

---

## Section 4: User Flows

### 1. Sign in flow

1. User opens the site (**deployed `dist/` from Vercel**, or **`npm run dev:react`** locally).  
2. User clicks “Sign in with Google”.  
3. **`src/App.tsx`** calls `signInWithPopup(auth, GoogleAuthProvider)` (custom parameter `prompt: "select_account"`). Firebase Auth sessions are **per origin** (host + port); local dev on a different port than production is a separate session. **`auth/unauthorized-domain`** is handled in UI (add the host in Firebase Console → Authentication → Authorized domains).  
4. Firebase Auth completes Google OAuth; `onAuthStateChanged` fires with a user.  
5. **`WatchlistPage`** loads profile / lists via React Query and **`useWatchlistSessionRestore`** (`/join/:listId` plus legacy `?join=` redirect, last list, filter prefs from **`storage.ts`**).  
6. List data: `getPersonalListMovies` / `getSharedListMovies` via **`src/firebase.ts`**.  
7. **`TitleGrid`** / **`TitleCard`** render the grid; filters persisted per uid in **`localStorage`**.

### 2. Add title via IMDb bookmarklet flow

1. User drags bookmarklet from **`public/bookmarklet.html`** (bookmark is a `javascript:` URL that injects **`public/bookmarklet.js`** from the deployed origin).  
2. On an IMDb title page, user runs bookmarklet: validates pathname `/title/ttxxxx`.  
3. Script opens popup to `{site}/add.html?imdbId=...&embed=1` (production URL hardcoded in `bookmarklet.js`).  
4. **`src/add-main.ts`** validates IMDb id; subscribes to `onAuthStateChanged`.  
5. If not signed in: show error; `postMessage` to parent/opener; optionally close popup.  
6. If signed in: read `getUserProfile` for `watch_region`; read optional `listId` from cookie `bookmarklet_list_id` (shared list) and optional `personalListId` from cookie `bookmarklet_personal_list_id` (current personal list’s real subdoc id, set by the main app).  
7. `fetch("/api/add-from-imdb", { POST, Authorization: Bearer <getIdToken()> })` with body `{ imdbId, watch_region, listId?, personalListId? }`.  
8. **`/api/add-from-imdb`** verifies token → `uid`; loads OMDb; if `TMDB_API_KEY` present, runs TMDB find + detail + videos + watch providers; else falls back to OMDb-only row; writes to `sharedLists/{listId}` or `users/{uid}/personalLists/{personalListId}` (default id from profile if cookie absent); migrates legacy `users/{uid}.items` on first write when needed.  
9. Response JSON returned; add page displays message; `postMessage({ type: "add-result", ... })` to opener/parent; bookmarklet shows toast and closes popup.  
10. **Main watchlist tab does not automatically reload** from this flow; user refreshes or revisits to see new titles (unless they were already polling — they are not).

**Upcoming alerts sync (separate from bookmarklet):** Manual HTTP / `curl` should call `/api/trigger-upcoming-sync` (GET/POST) for long runs; **`/api/check-upcoming`** is for cron + Admin “Run now”. Both use `runRegistrySyncWithTimeBudget`.

### 3. TMDB enrichment flow (add path)

**Implemented in** `api/add-from-imdb.js` (POST) and conceptually:

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
2. Client `POST`s `/api/join-shared-list` with JSON `{ listId }`, `credentials: "include"` — **`useWatchlistSessionRestore.ts`** (legacy query redirect on load) or **`ManageListsModal.tsx`** (paste URL). Function reads Firebase ID token from cookie and/or `Authorization` header.
3. Function verifies Firebase ID token, `arrayUnion(uid)` on `members` if not already present (fails with **400** if the list document has no non-empty `name` and the user was not already a member).  
4. Client refreshes shared lists, switches `currentListMode` to that shared list.

**Join via paste:**  
- Lists modal “Join” reads URL from input, extracts `join` query param, same POST as above.

**Copy invite (header):**  
- When viewing a shared list, “Copy invite link” copies `/join/{listId}`.

### 5. Watch provider lookup flow

1. **At add time:** User’s `country` on `users/{uid}` is read in **`src/add-main.ts`** as `watch_region` and sent to `add-from-imdb`.  
2. **Server:** `enrichFromTmdb` fetches TMDB watch providers for that region and stores provider **names** on the new/merged item as `services` (array of strings).  
3. **At display time:** **`servicesForMovie(m, userCountryCode)`** in **`src/lib/movieDisplay.ts`** (used by **`TitleCard`** / **`TrailerModal`**) prefers `m.servicesByRegion[countryCode]`, else `m.services`.  
4. **Persisting region-specific cache:** no watchlist client helper; `services` / `servicesByRegion` are set at add time (**`/api/add-from-imdb`**) or by scripts.

### 6. WhatsApp → add title flow

1. User configures Meta’s webhook to **`/api/whatsapp-webhook`** and sets **`WHATSAPP_*`** env vars on Vercel.  
2. In the app, user opens profile menu → **WhatsApp** (**`WhatsAppSettings`** dialog): enters E.164 number, default list, **`POST /api/whatsapp-verify`** sends a code; user enters code; verify path writes **`verificationCodes`** (Admin) and **`phoneIndex`** + **`users.phoneNumbers`**.  
3. User sends a message containing an **IMDb URL** or **`tt…`** id to the WhatsApp business number.  
4. **`whatsapp-webhook`** resolves **`from`** → **`phoneIndex`**; loads **`users/{uid}.country`** for watch region; calls **`performAddFromImdbByUid`** (same core as bookmarklet).  
5. Replies with a short **Graph API** text (added / duplicate / error / unregistered / no IMDb in message).

---

## Section 5: Component Map

| Name / file | Responsibility | Reads Firestore | Writes Firestore | External APIs |
|-------------|----------------|-----------------|------------------|---------------|
| `index.html` / `src/main.tsx` | Vite entry; mounts React (`App` → routes → `WatchlistPage` / `JoinPage` / `AdminPage`). | — | — | Google Fonts (from HTML) |
| `src/pages/AdminPage.tsx` | Admin-only dashboard: stats, upcoming job controls, GitHub backup status, **Service Links** (Vercel env vars, Meta WhatsApp console, Google Cloud billing, Firebase, etc.). | Via queries / `fetch` to admin APIs | — | `fetch` → `github-backup-status`, `admin-job-config`; external HTTPS links |
| `src/components/WhatsAppSettings.tsx` | Dialog: list linked numbers, default list per number, connect flow; **`fetch`** → **`/api/whatsapp-verify`**. | Via `src/firebase.ts` | Via `src/firebase.ts` (`phoneIndex`, `users.phoneNumbers`) | WhatsApp verify API |
| `src/components/*.tsx`, `src/components/modals/*.tsx`, `src/hooks/*` | React watchlist UI (see Architecture). | Via `src/firebase.ts` | Via `src/firebase.ts` | `fetch` → `join-shared-list`, `log-client-event`, admin functions where used; YouTube embeds; clipboard |
| `src/store/watchlistConstants.ts` | Status labels, checkmark/upcoming SVG snippets, `GENRE_LIMIT`. | — | — | — |
| `src/lib/movieDisplay.ts` | `servicesForMovie`, `renderServiceChips`, `hasPlayableTrailerYoutubeId`. | — | — | — |
| `src/config/firebase.ts` | Firebase Web SDK config from `import.meta.env` (`VITE_FIREBASE_*`) with normalization/sanitization and safe defaults. | — | — | — |
| `src/firebase.ts` | Imports config, initializes App/Auth/Firestore, optional Analytics (`getAnalytics(app)` when allowed — not exported); **`titleRegistry`** hydration, user/shared/personal list CRUD, status keys, upcoming helpers, admin job config fetch. | `titleRegistry`, `users/*`, `sharedLists/*`, `personalLists/*` | Same | Firebase SDK (npm, Vite bundle) |
| `src/countries.ts` | Static ISO country list + flags for country modal. | — | — | — |
| `src/lib/youtube-trailer-id.ts` | Validate/normalize TMDB YouTube key strings. | — | — | — |
| `src/lib/axiom-logger.ts` | POST signed-in events to **`/api/log-client-event`**. | — | — | Same-origin `fetch` |
| `add.html` | Minimal page for add result. | — | — | — |
| `src/add-main.ts` | Bookmarklet target: auth gate, call add function. | `getUserProfile` | — | `fetch` → `add-from-imdb` |
| `public/bookmarklet.html` | Instructions + draggable bookmark. | — | — | — |
| `public/bookmarklet.js` | On IMDb: open popup, `postMessage` handshake. | — | — | Opens hosted `add.html` (hardcoded production host + localhost for dev) |
| `api/add-from-imdb.js` | Auth verify, OMDb/TMDB enrichment, merge/write list docs. | Firestore via Admin | `users`, `sharedLists` | OMDb, TMDB |
| `api/join-shared-list.js` | Add member to shared list. | Firestore via Admin | `sharedLists` | — |
| `api/whatsapp-webhook.js` | Meta webhook; inbound IMDb text → `add-from-imdb` by mapped uid. | Firestore via Admin | — (uses add-from-imdb for lists / registry) | Meta Graph send; TMDB/OMDb indirect |
| `api/whatsapp-verify.js` | Link phone: send/verify code; write `phoneIndex`, `users`, `verificationCodes`. | Firestore via Admin | `phoneIndex`, `users`, `verificationCodes` | Meta Graph send |
| `src/api-lib/phone-index.js`, `src/api-lib/whatsapp-graph.js` | Shared helpers for **`phoneIndex`** CRUD and Graph text messages. | — | — | Meta Graph API |
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
    ADD["add.html + add-main"]
    BM["bookmarklet on imdb.com"]
  end

  subgraph VercelAPI["Vercel serverless"]
    NF1["add-from-imdb"]
    NF2["join-shared-list"]
    NF3["check-upcoming (scheduled)"]
    NF4["trigger-upcoming-sync (HTTP)"]
    NF5["whatsapp-webhook / whatsapp-verify"]
    Static["Static assets"]
  end

  subgraph Firebase["Firebase"]
    FS["Firestore"]
    FA["Auth"]
  end

  subgraph External["External APIs"]
    TMDB["TMDB API"]
    OMDb["OMDb API"]
    WA["Meta WhatsApp API"]
    YT["YouTube embeds"]
    GFonts["Google Fonts"]
  end

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
  NF5 --> FS
  NF5 --> FA
  NF5 --> WA

  SPA --> YT
```

### IMDb bookmarklet → TMDB enrichment → card (sequence diagram)

```mermaid
sequenceDiagram
  participant User
  participant IMDb as imdb.com
  participant BM as bookmarklet.js
  participant Popup as add.html + add-main.ts
  participant Auth as Firebase Auth
  participant NF as Vercel add-from-imdb
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

**Note:** List **content** (`items`, status arrays) lives on **`personalLists`** and **`sharedLists`** docs only. The **`users/{uid}`** doc holds profile + **`defaultPersonalListId`** + dismissals + optional **`phoneNumbers`**; legacy root-level `items` / `listName` were migrated into the default personal list (Section 3). **`catalog`** was removed (Section 3). **`phoneIndex`** maps a digits-only phone id to **`uid`** and default add list (Section 3).

```mermaid
erDiagram
  USER_DOC ||--o{ PERSONAL_LIST : "users/uid/personalLists"
  USER_DOC ||--o{ PHONE_INDEX : "phoneNumbers[] to phoneIndex id"
  USER_DOC {
    string uid PK "document id"
    string defaultPersonalListId
    string country
    string countryName
  }
  PHONE_INDEX {
    string digits PK "document id"
    string uid FK "users uid"
    string defaultAddListId
    string defaultListType
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

*Audit note (codebase check): each item below states whether the gap **still exists**, is **partially** addressed, or is **resolved** as documented behavior (not a gap).*

1. **Web app config** — **Resolved / by design.** Firebase web settings are loaded from `VITE_FIREBASE_*` via `src/config/firebase.ts` and Vite (`import.meta.env`). No change needed.

2. **Secrets in repository** — **Split: private vs public Firebase config.**  
   - **`src/config/firebase.ts` (current):** Each field is resolved with **`import.meta.env.VITE_FIREBASE_*` first**, then falls back to **`DEFAULT_FIREBASE_WEB_CONFIG`** — a **hardcoded** object (`apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId`, `appId`, `measurementId`) for this Firebase **web** app. So the repo does **not** read web config from env alone; embedded public client values always exist as fallback.  
   - **Git history:** An older committed version (`d52be42` / “finalize UI migration…”) required **`VITE_FIREBASE_*` only** (no in-repo defaults). Later commits (e.g. auth-domain normalization, masked-env fallbacks) **introduced** `DEFAULT_FIREBASE_WEB_CONFIG` so builds still work when CI / host env is masked or unset.  
   - **Admin / service account:** **No private key material in git.** Committed code only references the **`FIREBASE_SERVICE_ACCOUNT` env var name** (functions, scripts, docs, `.env.example` with an empty value, GitHub Actions `${{ secrets.FIREBASE_SERVICE_ACCOUNT }}`). **`.gitignore`** includes **`.env`**, **`.env.local`**, **`.env.*.local`**, and **`serviceAccountKey.json`**.  
   - **Verdict:** The **gap about leaking the service account** is **resolved** (appropriate ignores + no credential blobs in tracked files). The **embedded web config** is **intentional** for this project’s public Firebase client settings, not a partial “secret” leak — **forks** should replace defaults or set **`VITE_FIREBASE_*`** for their own Firebase project.

3. **Bookmarklet portability** — **Still exists (audit: Mar 2026).** Nothing reads deployment origin dynamically. **`public/bookmarklet.js`** hardcodes **`https://watchlist-trailers.vercel.app`** for the popup URL and allows legacy **`watchlist-trailers.netlify.app`** for **`postMessage`** (plus **`localhost`** with optional port). **`public/bookmarklet.html`** hardcodes the Vercel host in the draggable bookmark’s **`bookmarklet.js`** script `src`. Forks / alternate domains must edit both files.

4. **Bookmarklet target lists** — **Still accurate (audit).** **`api/add-from-imdb.js`** resolves target list from POST body first, then cookies: **`listId`** ← `body.listId` or **`bookmarklet_list_id`**; personal list ← **`bookmarklet_personal_list_id`** or `body.personalListId`. Matches the client setting those cookies (**`src/lib/bookmarkletCookie.ts`**, **`src/add-main.ts`**).

5. **Firestore rules vs Admin** — **Accepted architecture (not a bug).** **`firestore.rules`**: **`titleRegistry`**, **`upcomingAlerts`**, and **`syncState`** deny client writes (`allow write: if false` where applicable); **`sharedLists`** / **`users`** follow member/owner rules. **`api/*`** routes use **Firebase Admin SDK** and bypass rules by design. *Operational reality (true for any admin key):* compromise of **`FIREBASE_SERVICE_ACCOUNT`** implies broad Firestore access — expected tradeoff, not an open “gap” to close in app code.

6. **Shared list join token** — **Still exists (audit).** **`api/join-shared-list.js`** verifies only the Firebase **ID token** (`bookmarklet_token` cookie or **`Authorization: Bearer`**) and **`body.listId`**. **No** invite-specific secret or signed invite token was added; anyone who can authenticate and supply a valid **`listId`** can attempt to join (subject to list existing, having a name, membership rules).

7. **`join-shared-list` CORS** — **Still implemented; acceptable for current setup (audit).** **`corsHeaders(event)`** sets **`Access-Control-Allow-Origin`** to the request **`Origin`** header (or **`*`** if absent). **`Access-Control-Allow-Credentials: true`** is set. For the SPA on the **same deployment origin** calling **`/api/join-shared-list`**, the browser sends the real site origin; echoing it is the usual pattern for credentialed requests to same-site API routes. *Residual concern:* only if the function were called from additional allowed origins without updating CORS policy.

8. **Composite indexes** — **Still no repo file (audit).** There is **no** **`firestore.indexes.json`** committed. **`src/firebase.ts`** still queries **`sharedLists`** with **`where("members", "array-contains", uid)`** (`getSharedListsForUser`). Firebase typically auto-provisions a single-field index for that query; any **composite** index Firebase requests would be created in the **Firebase console** (or a future checked-in `firestore.indexes.json`), not in this repo today.

9. **“Recently Added” tab** — **Partially resolved (unchanged from prior audit).** **`src/lib/watchlistFilters.ts`**: “recently-added” collects **to-watch** items, sorts primarily by persisted **`addedAt`** (ISO), then tie-breaks by **array index** (`b.index - a.index`). **`src/firebase.ts`** persists **`addedAt`** on list rows via **`rowToStore` / `ensureAddedAt`**. *Residual:* missing **`addedAt`** uses **`NEGATIVE_INFINITY`** so order falls back to index among ties — legacy rows may behave like “array order” for those entries.

10. **`src/firebase.ts` public surface** — **Resolved / by design (audit).** Module defines internal **`db`** (`initFirestoreWithLocalCache()`) and loads Analytics via dynamic import **without** exporting either. The **`export { … }`** block lists only **named helpers** (auth exports, list CRUD, upcoming, job config, etc.). Import specifiers in TS often use **`./firebase.js`**; Vite resolves **`firebase.ts`**.

---

*End of document.*
