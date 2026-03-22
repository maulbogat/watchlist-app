# movie-trailer-site

A personal movie/show watchlist with YouTube trailers, filters, and Firestore. **Architecture, data model, and flows** are documented in **[`system-design.md`](./system-design.md)** (source of truth for how pieces fit together).

**Stack:** React 19 + Vite 6 (`src/`), Zustand + TanStack Query, client Firestore/Auth via **`src/firebase.ts`** + **`src/config/firebase.ts`** (reads `VITE_FIREBASE_*` from Vite env). Netlify hosts **`dist/`** and runs **`netlify/functions/*.js`** (Admin SDK) for the IMDb add flow, shared-list joins, and upcoming-title sync.

## Run locally

The watchlist is **React** (`src/`) served by **Vite**. Root **`index.html`** is the Vite entry (`#root` + `/src/main.jsx`). **`npm run build:react`** outputs **`dist/`**, which Netlify publishes.

**Requirements:** [Node.js](https://nodejs.org/) **18+** and npm.

```bash
npm install
npm run dev:react
```

Open the URL Vite prints (e.g. `http://localhost:5173`). The dev server uses `--host` so LAN devices can reach it if needed.

- **Firebase Auth:** Add your dev host (e.g. `localhost` and the port you use) under Firebase Console → Authentication → Settings → **Authorized domains**.
- **Netlify functions locally:** `vite.config.ts` proxies `/.netlify/functions/*` to `http://localhost:8888`. To exercise the bookmarklet add flow against real functions, run **`netlify dev`** in another terminal (or start the functions server on `8888` per Netlify docs) while using the Vite app.

**Other commands**

| Command | Purpose |
|--------|---------|
| `npm run dev:react` | Dev server (HMR) |
| `npm run build:react` | Production bundle → `dist/` |
| `npm run preview:react` | Serve `dist/` locally |
| `npm run test:run` | Run Vitest test suite once |

## Environment configuration

- Copy `/.env.example` to `/.env` for local scripts/functions.
- Create `/.env.local` for Vite client variables (this file is gitignored).
- Required client variables:
  - `VITE_FIREBASE_API_KEY`
  - `VITE_FIREBASE_AUTH_DOMAIN`
  - `VITE_FIREBASE_PROJECT_ID`
  - `VITE_FIREBASE_STORAGE_BUCKET`
  - `VITE_FIREBASE_MESSAGING_SENDER_ID`
  - `VITE_FIREBASE_APP_ID`
  - `VITE_FIREBASE_MEASUREMENT_ID`
- `src/config/firebase.ts` validates required Firebase env keys at runtime and throws a clear error when missing.

## Firebase setup

1. **Enable Authentication** → Sign-in method → Google → Enable
2. **Create Firestore Database** → Start in production mode
3. **Deploy Firestore rules** from `firestore.rules`:
   ```bash
   firebase deploy --only firestore:rules
   ```
   Or paste the rules in Firebase Console → Firestore → Rules

4. **Movie lists** are stored under **`users/{uid}/personalLists/{listId}`** (plus optional **shared lists** in **`sharedLists/{listId}`**). The **`users/{uid}`** document holds profile fields (e.g. country, **`defaultPersonalListId`**) and optional **`upcomingDismissals`** — not the row arrays. Canonical title metadata lives in **`titleRegistry/{registryId}`** (client read-only; writes via Netlify/scripts). Users add titles via the bookmarklet; no legacy **`catalog`** collection is used.

## Netlify deployment (bookmarklet)

**Build:** `netlify.toml` runs **`npm run build:react`** and publishes **`dist/`** (includes `index.html` + hashed assets). The live site is the **React** watchlist.

For the IMDb bookmarklet to add titles from imdb.com:

1. Set `FIREBASE_SERVICE_ACCOUNT` in Netlify → Site settings → Environment variables:
   ```bash
   base64 -i serviceAccountKey.json | tr -d '\n'
   ```
   Paste the output as the value.

2. Set `OMDB_API_KEY` in Netlify → Site settings → Environment variables. Get a free key at [omdbapi.com](https://www.omdbapi.com/apikey.aspx).

3. Set `TMDB_API_KEY` in Netlify → Site settings → Environment variables (for trailer lookup and **upcoming** sync). Get a free key at [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api).

4. Set all `VITE_FIREBASE_*` variables in Netlify → Site settings → Environment variables so production `vite build` can initialize Firebase:
   - `VITE_FIREBASE_API_KEY`
   - `VITE_FIREBASE_AUTH_DOMAIN`
   - `VITE_FIREBASE_PROJECT_ID`
   - `VITE_FIREBASE_STORAGE_BUCKET`
   - `VITE_FIREBASE_MESSAGING_SENDER_ID`
   - `VITE_FIREBASE_APP_ID`
   - `VITE_FIREBASE_MEASUREMENT_ID`

5. **Upcoming episodes / movies (optional UI):** Netlify runs `check-upcoming` on a schedule (3:00 UTC) to fill `upcomingAlerts` from **`titleRegistry`** and TMDB. Deploy **`firestore.rules`** so signed-in users can read `upcomingAlerts` and **`titleRegistry`**. The app shows dismissible pills for the list you’re viewing. Adding a title via the bookmarklet upserts **`titleRegistry`** and triggers a one-title sync when `tmdbId` is present.

   **If `curl …/check-upcoming` returns Netlify “Internal Error”** or logs show **Duration: 30000 ms** with no `check-upcoming: done`: the old “full registry in one run” flow **exceeds Netlify’s ~30s limit**. The deployed function now uses a **time budget + Firestore cursor** (`syncState/upcomingAlerts`, Admin-only — deploy updated **`firestore.rules`**). Use **Netlify → Functions → check-upcoming → Run now** repeatedly until logs show **`completed":true`** (or wait for daily cron). Each run should finish under 30s; **`upcomingAlerts`** appears after the first chunk writes.

   **Manual HTTP / `curl`:** Do **not** call `/.netlify/functions/check-upcoming` — Netlify **scheduled** functions often fail **within ~1s** when hit by URL (while **Run now** in the dashboard still works). Use the separate HTTP function:

   ```bash
   curl -X POST "https://YOUR-SITE.netlify.app/.netlify/functions/trigger-upcoming-sync"
   ```

   Repeat until the JSON shows `"completed":true` (same chunked sync as the scheduler). Optional: set **`UPCOMING_SYNC_TRIGGER_SECRET`** in Netlify and send `Authorization: Bearer <that-value>` so random people can’t trigger TMDB/Firestore work.

   **Firestore `RESOURCE_EXHAUSTED` / “Quota exceeded”** in function logs usually means the **Spark (free) plan daily read/write budget** was hit, or two runs overlapped and doubled traffic. The sync now **pages through `titleRegistry`** (instead of downloading the whole collection every run) and **retries** quota errors with backoff. If errors persist: upgrade to **Blaze (pay-as-you-go)** in Firebase, reduce how often you manually trigger sync, or run **`node scripts/sync-upcoming-alerts.mjs`** locally when the registry is large.

   **One-shot full sync on your machine** (no 30s limit):

   ```bash
   node scripts/sync-upcoming-alerts.mjs
   ```

   Uses `TMDB_API_KEY` and `FIREBASE_SERVICE_ACCOUNT` / `serviceAccountKey.json`. May take several minutes on a large `titleRegistry`.

   **Existing data:** run `node scripts/migrate-to-title-registry.mjs --dry-run` then without `--dry-run` to move list `items` to `{ registryId }` and remap status keys. After migration, remove legacy Firestore docs: `node scripts/delete-legacy-catalog.mjs --dry-run` then `--write`.

   **Personal list storage:** Watchlist rows live under `users/{uid}/personalLists/{listId}` (same idea as `sharedLists`). The user doc keeps profile fields and `defaultPersonalListId` only. Legacy `users/{uid}.items` is migrated automatically when users open the app or use the bookmarklet; optional bulk: `node scripts/migrate-personal-items-to-subcollection.mjs --dry-run` then `--write`.

6. Visit `/bookmarklet.html` on your deployed site, drag the button to your bookmarks bar, then sign in with Google. When on an IMDb title page, click the bookmarklet to add it to your watchlist.

## Multi-user support

Multiple people can use the app with their own Google accounts. Each account has its own **personal lists** (default list + optional extra lists in the subcollection). The bookmarklet adds to the **currently selected** list in the main app (personal or shared). Items go only to lists that user is allowed to write (see Firestore rules).

## Shared lists

Create shared lists that multiple people can add to and update together:

1. **Create:** Use the list dropdown → "+ Create shared list" → enter a name
2. **Share:** Copy the link shown and send it to others
3. **Join:** Others open the link while signed in to join the list
4. **Add items:** When viewing a shared list, the bookmarklet adds to that list (sign in and switch to the shared list first)

Deploy Firestore rules: `firebase deploy --only firestore:rules`

**Verify in Firebase Console:**

1. **Authentication → Sign-in method** → Google → Enabled
2. **Authentication → Settings → Authorized domains** → Add your Netlify URL (e.g. `watchlist-trailers.netlify.app`) and `localhost` for local dev
3. **Firestore rules** (in `firestore.rules`) — signed-in users: read/write their **`users/{uid}`** doc and **`users/{uid}/personalLists/*`**; read/write **`sharedLists/{listId}`** only when their uid is in **`members`**; read **`titleRegistry`** and **`upcomingAlerts`** (no client writes there). **`syncState`** is Admin-only.

The header shows the signed-in user's email so family members know whose account they're using on shared devices.

## Recover lost titles

If you lost titles (e.g. after a failed move), run the recovery script to scan Firestore and restore:

```bash
# Scan shared lists, users, and related sources — report what's found
node scripts/recover-titles.js

# Restore all found titles to your personal list
node scripts/recover-titles.js <your-uid> --restore
```

Get your UID: `node scripts/list-users.js` or Firebase Console → Authentication → Users.

Requires `serviceAccountKey.json` in project root, or `FIREBASE_SERVICE_ACCOUNT` env var.

## Export Firestore to JSON (inspect / `grep` / `rg`)

Pull **titleRegistry**, **upcomingAlerts**, **sharedLists**, **users**, and each user’s **personalLists** subcollection into one file:

```bash
node scripts/backup-firestore.js
# custom path:
node scripts/backup-firestore.js backups/my-snapshot.json
# skip upcomingAlerts if the file gets huge:
node scripts/backup-firestore.js --no-alerts
node scripts/backup-firestore.js backups/slim.json --no-alerts
```

Then search locally, e.g. `rg 'tt15677150|136311|Shrinking' backups/firestore-backup.json`.

Same credentials as other scripts: `serviceAccountKey.json` or `FIREBASE_SERVICE_ACCOUNT`.

**Move default personal list → shared “Our list”** (merge + clear personal; dedupes by registry id):

```bash
node -r dotenv/config scripts/move-personal-to-shared.mjs --dry-run <uid>
node -r dotenv/config scripts/move-personal-to-shared.mjs --write <uid>   # optional: third arg = shared list name
```

**Shared list: put every title on the “To Watch” tab** (keeps `items`; clears `watched` / `maybeLater` / `archive`):

```bash
node -r dotenv/config scripts/reset-shared-list-all-to-watch.mjs --dry-run "Our list"
node -r dotenv/config scripts/reset-shared-list-all-to-watch.mjs --write "Our list"
```

**Audit candidate titles vs “Our list”** (lines = `Title|Year` and/or `tt…` comments; edit `scripts/audit-candidates-input.txt`):

```bash
node -r dotenv/config scripts/audit-candidates-vs-our-list.mjs
```

Also writes **`backups/audit-candidates-manual-review.txt`**: every line that is unresolved, not on “Our list”, or doesn’t exactly match `titleRegistry` title/year (including fallback matches like title-only).

To **delete the legacy `removed` field** from `sharedLists`, `users`, and personal lists (not used by the app):

```bash
node scripts/strip-removed-field.js --dry-run
node scripts/strip-removed-field.js --write
```

## Maintenance scripts (titleRegistry)

- **Registry report** (trailers, thumbs, services): `node scripts/registry-report.js`
- **Add by IMDb id** (TMDB enrichment): `node scripts/add-title-by-imdb.js tt12345678`
- **Delete legacy `catalog` collection** (after migration): `node scripts/delete-legacy-catalog.mjs --write`

**Local diagnostics** (Admin + `.env` / `serviceAccountKey.json`; see each file’s header for env vars):

- **Upcoming alerts vs TMDB** (read-only report): `node check-upcoming.mjs`
- **TMDB vs Trakt “next episode”** (read-only): `node compare-upcoming-trakt.mjs`

Many scripts expect **`TMDB_API_KEY`**, **`FIREBASE_SERVICE_ACCOUNT`** (base64) or **`serviceAccountKey.json`**, and often **`dotenv`** — e.g. `node -r dotenv/config scripts/...`.

## Features

- **Watchlist UI (React):** grid of titles with poster, status controls, and **trailer modal** (YouTube embed).
- **Personal lists:** default list + extra lists; **manage lists** modal (create/rename/delete, pick default).
- **Shared lists:** create, copy invite link (`/join/:listId`), join while signed in; bookmarklet targets the list you’re viewing.
- **Status tabs:** Recently Added, To Watch (**includes “maybe later”** rows), Watched, Archive — persisted in Firestore.
- **Filters:** Movies / TV / Both, **genre**, persisted per account in **localStorage** (with session restore).
- **Country / region:** set in app for TMDB **watch providers** at add time; **service chips** on cards (e.g. Netflix, Prime).
- **Upcoming:** dismissible **upcoming alerts** bar for the current list (backed by **`upcomingAlerts`** + scheduled **`check-upcoming`**; optional calendar export when dated).
- **Bookmarklet:** add from **imdb.com** via **`add.html`** + **`/.netlify/functions/add-from-imdb`**.
- **Google sign-in:** same Firebase project as production; remember **authorized domains** for each host/port you use locally.
