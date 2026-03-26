# movie-trailer-site

A personal movie/show watchlist with YouTube trailers, filters, and Firestore. **Architecture, data model, and flows** are documented in **[`system-design.md`](./system-design.md)** (source of truth for how pieces fit together).

**Stack:** React 19 + Vite 6 (`src/`), Zustand + TanStack Query, client Firestore/Auth via **`src/firebase.ts`** + **`src/config/firebase.ts`** (reads `VITE_FIREBASE_*` from Vite env). **Vercel** hosts **`dist/`** and runs **`api/*.js`** serverless routes (Firebase Admin SDK) for the IMDb add flow, shared-list joins, **email app invites** (single **`/api/invites`** route: GET list, POST `action: send|accept`, DELETE revoke — Resend on send), upcoming-title sync, **WhatsApp** verification + webhook (Meta Cloud API), and other admin/diagnostic endpoints.

## Environment Quick Start

```bash
cp .env.example .env
# create/edit .env.local manually (client-only keys)
```

Then set values in:

- `.env` for server/scripts vars (`TMDB_API_KEY`, `OMDB_API_KEY`, `FIREBASE_SERVICE_ACCOUNT`, optional `AXIOM_*`, optional **`RESEND_API_KEY`**, optional **`RESEND_FROM_EMAIL`**, optional **`APP_PUBLIC_URL`**, optional script toggles)
- `.env.local` for client/Vite vars (`VITE_FIREBASE_*`, optional `VITE_APP_VERSION`, optional `VITE_APP_ORIGIN`, `VITE_DEPLOYMENTS_URL`, `VITE_SITE_ID`, legacy `VITE_NETLIFY_*`)

**Vercel production:** mirror the same keys in the project **Settings → Environment Variables** (deep link from **`/admin`** → Service Links → **Vercel**). Naming and pitfalls are in **[`docs/environment.md`](./docs/environment.md)** (delete **`VITE_AXIOM_*`**; never expose **`AXIOM_*`** to the client bundle). WhatsApp uses **`WHATSAPP_VERIFY_TOKEN`**, **`WHATSAPP_APP_SECRET`** (webhook POST signature), **`WHATSAPP_TOKEN`**, and **`WHATSAPP_PHONE_NUMBER_ID`**; email invites use **`RESEND_API_KEY`** (and optional **`RESEND_FROM_EMAIL`**, **`APP_PUBLIC_URL`**) — see that doc and **`.env.example`**.

## Run locally

The watchlist is **React** (`src/`) served by **Vite**. Root **`index.html`** is the Vite entry (`#root` + `/src/main.jsx`). **`npm run build:react`** outputs **`dist/`**, which Vercel publishes (see **`vercel.json`**).

**Requirements:** [Node.js](https://nodejs.org/) **18+** and npm.

```bash
npm install
npm run dev:react
```

Open the URL Vite prints (e.g. `http://localhost:5173`). The dev server uses `--host` so LAN devices can reach it if needed.

- **Firebase Auth:** Add your dev host (e.g. `localhost` and the port you use) under Firebase Console → Authentication → Settings → **Authorized domains**.
- **API routes locally:** `vite.config.ts` proxies **`/api/*`** to **`http://localhost:3000`**. Run **`vercel dev`** in the repo root (serves API + env) on port **3000**, then **`npm run dev:react`** (Vite, port **5173**) in another terminal. Load the same `.env` / `.env.local` vars as production so **`log-client-event`**, **bookmarklet**, joins, and jobs work end-to-end.

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
- Optional client variables:
  - `VITE_FIREBASE_MEASUREMENT_ID` (Analytics)
  - `VITE_APP_VERSION` (defaults to `1.0.0` when missing)
  - `VITE_APP_ORIGIN` — production origin for Admin links (default in code: `https://watchlist-trailers.vercel.app`)
  - `VITE_DEPLOYMENTS_URL` — Admin “Deployments” card (e.g. `https://vercel.com/<team>/<project>/deployments`)
  - `VITE_SITE_ID` — optional; marks `SITE_ID` in **`/api/admin-env-status`**
  - `VITE_NETLIFY_SITE_ID` / `VITE_NETLIFY_PROJECT_SLUG` — optional legacy Netlify deploy badge only
- **Axiom (client events):** do **not** use `VITE_AXIOM_*`. The app POSTs to **`/api/log-client-event`** with a Firebase ID token; **`AXIOM_TOKEN`** and **`AXIOM_DATASET`** are server-only (Vercel env + local `.env` when running **`vercel dev`**).
- `src/config/firebase.ts` normalizes/sanitizes client config values and falls back to project defaults when values are missing or malformed.

## Firebase setup

1. **Enable Authentication** → Sign-in method → Google → Enable
2. **Create Firestore Database** → Start in production mode
3. **Deploy Firestore rules** from `firestore.rules`:
   ```bash
   firebase deploy --only firestore:rules
   ```
   Or paste the rules in Firebase Console → Firestore → Rules

4. **Movie lists** are stored under **`users/{uid}/personalLists/{listId}`** (plus optional **shared lists** in **`sharedLists/{listId}`**). The **`users/{uid}`** document holds profile fields (e.g. country, **`defaultPersonalListId`**) and optional **`upcomingDismissals`** — not the row arrays. Canonical title metadata lives in **`titleRegistry/{registryId}`** (client read-only; writes via **`api/*`** / scripts). Users add titles via the bookmarklet; no legacy **`catalog`** collection is used.

5. **App access (allowlist):** Only Google accounts that have a row in **`allowedUsers/{lowercaseEmail}`** can use the watchlist after sign-in. **`AllowlistGate`** reads that document; others are signed out and see a full-screen message. **`/join-app/:inviteId`** is exempt so invitees can sign in and call **`POST /api/invites`** with **`{ action: "accept", inviteId }`** first. Seed existing users once with Admin credentials:

   ```bash
   node scripts/seed-allowed-users.mjs --dry-run
   node scripts/seed-allowed-users.mjs --write
   ```

   Deploy updated **`firestore.rules`** (and **`firestore.indexes.json`** if prompted) before relying on **`allowedUsers`** / **`invites`**.

## Vercel deployment (bookmarklet)

**Build:** **`vercel.json`** sets **`npm run build:react`**, **`outputDirectory`: `dist/`** (includes `index.html`, `add.html`, hashed assets), **Cron** **`/api/check-upcoming`** at **03:00 UTC**, and **`maxDuration`** **60s** for heavy API routes (including **`/api/whatsapp-webhook`**). **`/api/whatsapp-verify`** uses a **30s** cap. Serverless handlers live under **`api/*.js`**.

**WhatsApp (optional):** In Meta’s app settings, point the webhook to **`https://<your-domain>/api/whatsapp-webhook`**. After **`WHATSAPP_*`** env vars are set, users can open the profile menu → **WhatsApp**, verify a number, pick a default list, and send **IMDb links** on WhatsApp to add titles (same enrichment path as the bookmarklet, server-side). Unregistered numbers get a short reply with a link to the site.

### Production missing new UI after a Git push?

GitHub alone does not update the live site — **Vercel must build and assign that deployment to production**.

1. **Vercel → Deployments:** Open the latest production deployment; confirm it matches the commit you pushed and read **Build logs** if it failed (often env vars).
2. **Git integration:** Production branch (e.g. `main`) must match the branch you push.
3. **Redeploy** or **clear build cache** from the deployment menu if assets look stuck.
4. **Browser:** Hard refresh (e.g. Cmd+Shift+R) or a private window if `index.html` cached old hashed JS.

For the IMDb bookmarklet to add titles from imdb.com:

1. Set `FIREBASE_SERVICE_ACCOUNT` in Vercel → Project → **Settings → Environment Variables**:
   ```bash
   base64 -i serviceAccountKey.json | tr -d '\n'
   ```
   Paste the output as the value.

2. Set `OMDB_API_KEY` in Vercel environment variables. Get a free key at [omdbapi.com](https://www.omdbapi.com/apikey.aspx).

3. Set `TMDB_API_KEY` in Vercel environment variables (for trailer lookup and **upcoming** sync). Get a free key at [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api).

4. Set all **`VITE_*`** variables for **production builds** and all **server** variables for **API routes** — naming and pitfalls (**never `VITE_AXIOM_*`**) are in **[`docs/environment.md`](./docs/environment.md)**.

5. **Summary (details in `docs/environment.md`):**
   - **Do not** set `VITE_AXIOM_TOKEN` / `VITE_AXIOM_DATASET` (unused; exposes or duplicates server secrets).
   - **`VITE_*` (Firebase, `VITE_APP_VERSION`, Admin URLs)** — required at **build** time on Vercel.
   - **Server-only** (`FIREBASE_SERVICE_ACCOUNT`, `TMDB_API_KEY`, `OMDB_API_KEY`, `AXIOM_*`, optional `UPCOMING_SYNC_TRIGGER_SECRET`, `WHATSAPP_*`) — for **`api/*`** at **runtime**.

   **Do not** put real **`AXIOM_DATASET`** values in **`.env.example`** or client code.

### Vercel / build hygiene

Keep **`AXIOM_*` on the server** only; do not reintroduce **`VITE_AXIOM_*`**. If a deploy flags a false positive secret in logs, adjust values or use Vercel’s guidance for omitted patterns.

6. **Upcoming episodes / movies (optional UI):** Vercel **Cron** invokes **`/api/check-upcoming`** on the schedule in **`vercel.json`** (3:00 UTC) to fill `upcomingAlerts` from **`titleRegistry`** and TMDB. Deploy **`firestore.rules`** so signed-in users can read `upcomingAlerts` and **`titleRegistry`**. The app shows dismissible pills for the list you’re viewing. Adding a title via the bookmarklet upserts **`titleRegistry`** and triggers a one-title sync when `tmdbId` is present.

   Job enable/disable is controlled in Firestore at `meta/jobConfig.checkUpcomingEnabled` (exposed in `/admin` Jobs section). The schedule remains on; when disabled, scheduled runs exit early.

   **If `curl …/api/check-upcoming` errors or times out:** the sync uses a **time budget + Firestore cursor** (`syncState/upcomingAlerts`, Admin-only — deploy updated **`firestore.rules`**). Use **Admin → Run now** (POST **`/api/check-upcoming`**) or cron until logs show **`completed":true`**. **`vercel.json`** sets **`maxDuration`** **60s** for the heaviest API routes.

   **Manual HTTP / `curl`:** You can POST **`/api/check-upcoming`** with `{"trigger":"manual"}` from the Admin UI, or use the dedicated trigger:

   ```bash
   curl -X POST "https://YOUR-SITE.vercel.app/api/trigger-upcoming-sync"
   ```

   Repeat until the JSON shows `"completed":true` (same chunked sync as the scheduler). Optional: set **`UPCOMING_SYNC_TRIGGER_SECRET`** in Vercel and send `Authorization: Bearer <that-value>` so random people can’t trigger TMDB/Firestore work.

   **Firestore `RESOURCE_EXHAUSTED` / “Quota exceeded”** in function logs usually means the **Spark (free) plan daily read/write budget** was hit, or two runs overlapped and doubled traffic. The sync now **pages through `titleRegistry`** (instead of downloading the whole collection every run) and **retries** quota errors with backoff. If errors persist: upgrade to **Blaze (pay-as-you-go)** in Firebase, reduce how often you manually trigger sync, or run **`node scripts/sync-upcoming-alerts.mjs`** locally when the registry is large.

   **One-shot full sync on your machine** (no 30s limit):

   ```bash
   node scripts/sync-upcoming-alerts.mjs
   ```

   Uses `TMDB_API_KEY` and `FIREBASE_SERVICE_ACCOUNT` / `serviceAccountKey.json`. May take several minutes on a large `titleRegistry`.

   **Existing data:** run `node scripts/migrate-to-title-registry.mjs --dry-run` then without `--dry-run` to move list `items` to `{ registryId }` and remap status keys. After migration, remove legacy Firestore docs: `node scripts/delete-legacy-catalog.mjs --dry-run` then `--write`.

   **Personal list storage:** Watchlist rows live under `users/{uid}/personalLists/{listId}` (same idea as `sharedLists`). The user doc keeps profile fields and `defaultPersonalListId` only. Legacy `users/{uid}.items` is migrated automatically when users open the app or use the bookmarklet; optional bulk: `node scripts/migrate-personal-items-to-subcollection.mjs --dry-run` then `--write`.

7. Visit `/bookmarklet.html` on your deployed site, drag the button to your bookmarks bar, then sign in with Google. When on an IMDb title page, click the bookmarklet to add it to your watchlist.

## Multi-user support

Multiple people can use the app with their own Google accounts, but **new** accounts must be **invited** (email invite → **`/join-app/:inviteId`**) or already present in **`allowedUsers`** (e.g. seeded). Each account has its own **personal lists** (default list + optional extra lists in the subcollection). The bookmarklet adds to the **currently selected** list in the main app (personal or shared). Items go only to lists that user is allowed to write (see Firestore rules).

## Shared lists

Create shared lists that multiple people can add to and update together:

1. **Create:** Use the list dropdown → "+ Create shared list" → enter a name
2. **Share:** After creation, copy the **`/join/{listId}`** link from the dialog and send it to people who are **already allowed** to use the app (same allowlist as Google sign-in)
3. **Invite by email:** Manage lists → **Invite someone** — optional shared list attachment; pending invites can be revoked
4. **Join (link):** Others open **`/join/{listId}`** while signed in to join the list (unchanged)
5. **Add items:** When viewing a shared list, the bookmarklet adds to that list (sign in and switch to the shared list first)

Deploy Firestore rules: `firebase deploy --only firestore:rules`

**Verify in Firebase Console:**

1. **Authentication → Sign-in method** → Google → Enabled
2. **Authentication → Settings → Authorized domains** → Add your production host (e.g. `watchlist-trailers.vercel.app` or your custom domain) and `localhost` for local dev
3. **Firestore rules** (in `firestore.rules`) — signed-in users: read/write their **`users/{uid}`** doc and **`users/{uid}/personalLists/*`**; read/write **`sharedLists/{listId}`** only when their uid is in **`members`**; read **`titleRegistry`** and **`upcomingAlerts`** (no client writes there); read their own **`allowedUsers/{email}`** row (document id matches normalized email); read **`invites`** (writes Admin-only). **`syncState`** is Admin-only.

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
- **Personal lists:** default list + extra lists; **manage lists** modal (create/rename/delete, pick default, **invite someone** + pending invites).
- **Shared lists:** create; share **`/join/:listId`** from the post-create dialog; join while signed in; optional list on email invite; bookmarklet targets the list you’re viewing.
- **App access:** **`allowedUsers`** + **`/join-app/:inviteId`**; profile menu **Bookmarklet** dialog (instructions + drag button; moved out of manage lists).
- **WhatsApp adds:** verified numbers and per-number default list (**`phoneIndex`** + **`users/{uid}.phoneNumbers`**); inbound messages handled by **`/api/whatsapp-webhook`** (see deployment above).
- **Admin (`/admin`, admin users only):** catalog/upcoming stats, upcoming job toggle, GitHub backup workflow status, and **Service Links** (production site, Firebase, **Vercel env vars**, **Meta WhatsApp** dev console, **Google Cloud billing**, GitHub, TMDB, Trakt, etc.).
- **Status tabs:** Recently Added, To Watch (**includes “maybe later”** rows), Watched, Archive — persisted in Firestore.
- **Filters:** Movies / TV / Both, **genre**, persisted per account in **localStorage** (with session restore).
- **Country / region:** set in app for TMDB **watch providers** at add time; **service chips** on cards (e.g. Netflix, Prime).
- **Upcoming:** dismissible **upcoming alerts** bar for the current list (backed by **`upcomingAlerts`** + scheduled **`check-upcoming`**; optional calendar export when dated).
- **Bookmarklet:** add from **imdb.com** via **`add.html`** + **`/api/add-from-imdb`**.
- **Google sign-in:** same Firebase project as production; remember **authorized domains** for each host/port you use locally.
