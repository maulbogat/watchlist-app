# movie-trailer-site

A personal movie/show watchlist with YouTube trailers, filters, and Firestore. Each account has its own list.

## Run locally

The watchlist is **React** (`src/`) served by **Vite**. Root **`index.html`** is the Vite entry (`#root` + `/src/main.jsx`). **`npm run build:react`** outputs **`dist/`**, which Netlify publishes.

**Requirements:** [Node.js](https://nodejs.org/) **18+** and npm.

```bash
npm install
npm run dev:react
```

Open the URL Vite prints (e.g. `http://localhost:5173`). The dev server uses `--host` so LAN devices can reach it if needed.

- **Firebase Auth:** Add your dev host (e.g. `localhost` and the port you use) under Firebase Console → Authentication → Settings → **Authorized domains**.
- **Netlify functions locally:** `vite.config.js` proxies `/.netlify/functions/*` to `http://localhost:8888`. To exercise the bookmarklet add flow against real functions, run **`netlify dev`** in another terminal (or start the functions server on `8888` per Netlify docs) while using the Vite app.

**Other commands**

| Command | Purpose |
|--------|---------|
| `npm run dev:react` | Dev server (HMR) |
| `npm run build:react` | Production bundle → `dist/` |
| `npm run preview:react` | Serve `dist/` locally |

## Firebase setup

1. **Enable Authentication** → Sign-in method → Google → Enable
2. **Create Firestore Database** → Start in production mode
3. **Deploy Firestore rules** from `firestore.rules`:
   ```bash
   firebase deploy --only firestore:rules
   ```
   Or paste the rules in Firebase Console → Firestore → Rules

4. **Movie lists** are stored per user in `users/{uid}`. Users add titles via the bookmarklet; no shared catalog is needed for new users.

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

4. **Upcoming episodes / movies (optional UI):** Netlify runs `check-upcoming` on a schedule (3:00 UTC) to fill `upcomingAlerts` from **`titleRegistry`** and TMDB. Deploy **`firestore.rules`** so signed-in users can read `upcomingAlerts` and **`titleRegistry`**. The app shows dismissible pills for the list you’re viewing. Adding a title via the bookmarklet upserts **`titleRegistry`** and triggers a one-title sync when `tmdbId` is present.

   **If `curl …/check-upcoming` returns Netlify “Internal Error”** or logs show **Duration: 30000 ms** with no `check-upcoming: done`: the old “full registry in one run” flow **exceeds Netlify’s ~30s limit**. The deployed function now uses a **time budget + Firestore cursor** (`syncState/upcomingAlerts`, Admin-only — deploy updated **`firestore.rules`**). Use **Netlify → Functions → check-upcoming → Run now** repeatedly until logs show **`completed":true`** (or wait for daily cron). Each run should finish under 30s; **`upcomingAlerts`** appears after the first chunk writes.

   **Manual HTTP / `curl`:** Do **not** call `/.netlify/functions/check-upcoming` — Netlify **scheduled** functions often fail **within ~1s** when hit by URL (while **Run now** in the dashboard still works). Use the separate HTTP function:

   ```bash
   curl -X POST "https://YOUR-SITE.netlify.app/.netlify/functions/trigger-upcoming-sync"
   ```

   Repeat until the JSON shows `"completed":true` (same chunked sync as the scheduler). Optional: set **`UPCOMING_SYNC_TRIGGER_SECRET`** in Netlify and send `Authorization: Bearer <that-value>` so random people can’t trigger TMDB/Firestore work.

   **One-shot full sync on your machine** (no 30s limit):

   ```bash
   node scripts/sync-upcoming-alerts.mjs
   ```

   Uses `TMDB_API_KEY` and `FIREBASE_SERVICE_ACCOUNT` / `serviceAccountKey.json`. May take several minutes on a large `titleRegistry`.

   **Existing data:** run `node scripts/migrate-to-title-registry.mjs --dry-run` then without `--dry-run` to move list `items` to `{ registryId }` and remap status keys. After migration, remove legacy Firestore docs: `node scripts/delete-legacy-catalog.mjs --dry-run` then `--write`.

   **Personal list storage:** Watchlist rows live under `users/{uid}/personalLists/{listId}` (same idea as `sharedLists`). The user doc keeps profile fields and `defaultPersonalListId` only. Legacy `users/{uid}.items` is migrated automatically when users open the app or use the bookmarklet; optional bulk: `node scripts/migrate-personal-items-to-subcollection.mjs --dry-run` then `--write`.

5. Visit `/bookmarklet.html` on your deployed site, drag the button to your bookmarks bar, then sign in with Google. When on an IMDb title page, click the bookmarklet to add it to your watchlist.

## Multi-user support

Multiple people can use the app with their own Google accounts. Each account has its own list of titles—items added via the bookmarklet go only to that account's list.

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
3. **Firestore rules** (in `firestore.rules`) — users can only read/write their own `users/{uid}` data

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

## Features

- Per-user lists (each account has its own titles)
- To Watch / Watched tabs
- Filter by Movies, Series, or Both
- Mark titles as watched (persists across devices via Google sign-in)
- Checkmark on watched cards
- Service chips (Netflix, Prime Video, etc.)
