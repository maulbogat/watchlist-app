# movie-trailer-site

A personal movie/show watchlist with YouTube trailers, filters, and Firestore. **Architecture, data model, and flows** are documented in **[`system-design.md`](./system-design.md)** (source of truth for how pieces fit together).

**Stack:** React 19 + Vite 6 (`src/`), Zustand + TanStack Query, client Firestore/Auth via **`src/firebase.ts`** + **`src/config/firebase.ts`** (reads `VITE_FIREBASE_*` from Vite env). Optional **[Sentry](https://sentry.io/)** error tracking: browser SDK in **`src/main.tsx`** when **`VITE_SENTRY_DSN`** is set (production-only; Firebase **`uid`** only in user context — no email or display name), server **`SENTRY_DSN`** on **`add-from-imdb`** and **`whatsapp-webhook`** only; optional Vite **`@sentry/vite-plugin`** when **`SENTRY_AUTH_TOKEN`** is set for source map upload. **Vercel** hosts **`dist/`** and runs **`api/*.js`** serverless routes (Firebase Admin SDK) for the IMDb add flow, shared-list joins, **email app invites** (single **`/api/invites`** route: GET list, POST `action: send|accept`, DELETE revoke — Resend on send), upcoming-title sync, **WhatsApp** verification + webhook (Meta Cloud API), and other admin/diagnostic endpoints.

## Design system

**`styles.css`** defines shared tokens in **`:root`** and documents them in the **WATCHLIST DESIGN SYSTEM** comment at the top of the file:

- **Colors:** `--color-gold`, `--color-red`, `--color-surface-1` / `-2` / `-3`, `--color-text-muted`
- **Typography:** `--text-xs` … `--text-xl` (five-step scale)
- **Radius:** `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-pill`
- **Spacing:** `--space-1` … `--space-12` (4px-based / 8px-aligned grid)

**Button primitives:** **`.btn-primary`**, **`.btn-secondary`**, **`.btn-ghost`**, **`.btn-destructive`** — legacy button classes are tied to these bases via comma-grouped selectors so overrides in the rest of the stylesheet still win in the cascade.

**`.cursorrules`** (repo root) enforces token usage for CSS/styling, points contributors at existing modal/header patterns, and requires documentation updates (README, **system-design.md**, **docs/environment.md**, **`.env.example`**) when features, API routes, collections, or env vars change.

## Environment Quick Start

```bash
cp .env.example .env
# create/edit .env.local manually (client-only keys)
```

Then set values in:

- `.env` for server/scripts vars (`TMDB_API_KEY`, `OMDB_API_KEY`, `FIREBASE_SERVICE_ACCOUNT`, optional **`FIRESTORE_HOURLY_READ_LIMIT`** / **`FIRESTORE_DAILY_READ_LIMIT`**, optional `AXIOM_*`, optional **`SENTRY_DSN`**, optional **`RESEND_API_KEY`**, optional **`RESEND_FROM_EMAIL`**, optional **`APP_PUBLIC_URL`**, optional **`VERCEL_API_TOKEN`** / **`VERCEL_PROJECT_ID`** (Admin deployment card), optional script toggles)
- `.env.local` for client/Vite vars (`VITE_FIREBASE_*`, optional **`VITE_SENTRY_DSN`**, optional `VITE_APP_VERSION`, optional `VITE_APP_ORIGIN`, `VITE_DEPLOYMENTS_URL`, `VITE_SITE_ID`)

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
- **API routes locally:** `vite.config.ts` proxies **`/api/*`** to **`http://localhost:3000`**. In one terminal run **`vercel dev --listen 3000`** at the repo root (API + env); in another run **`npm run dev:react`** (Vite, port **5173**). Use the same `.env` / `.env.local` vars as production so **`log-client-event`**, **bookmarklet**, joins, and jobs work end-to-end.

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
  - `VITE_APP_ORIGIN` — production origin for Admin links (default in code: `https://watchlist.maulbogat.com`)
  - `VITE_DEPLOYMENTS_URL` — Admin “Deployments” card (e.g. `https://vercel.com/<team>/<project>/deployments`)
  - `VITE_SITE_ID` — optional; marks `SITE_ID` in **`/api/admin-env-status`**
- **Axiom (observability):** ingestion is **direct HTTP** to Axiom (not a Netlify log drain; drains are an Enterprise feature). The browser does **not** embed Axiom tokens: **`src/lib/axiom-logger.ts`** POSTs signed-in events to **`/api/log-client-event`**, which forwards using server-only **`AXIOM_TOKEN`** / **`AXIOM_DATASET`**. Server routes use **`src/api-lib/logger.js`**, which calls the Axiom HTTP API when those vars are set, otherwise **`console.log`** JSON. Do **not** set **`VITE_AXIOM_*`** (unused in bundles). Locally, leaving **`AXIOM_*`** unset avoids polluting the production dataset; logs go to the terminal instead.
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

### Vercel migration (from Netlify)

The project was migrated from **Netlify** to **Vercel**: former **`netlify/functions/`** handlers live under root **`api/*.js`**. **`src/api-lib/vercel-adapter.js`** keeps Netlify-shaped handler wiring while exposing standard Node **`(req, res)`** to Vercel. **`vercel.json`** replaces Netlify scheduled functions with **Vercel Cron** (e.g. **`/api/check-upcoming`** at **03:00 UTC**). On the **Hobby** plan, **12** serverless function slots are available; this repo defines **12** API routes. **`vercel.json`** sets **`npm run build:react`**, **`outputDirectory`: `dist/`** (includes `index.html`, `add.html`, hashed assets), SPA rewrite (excluding **`/api/*`**), cron, and per-function **`maxDuration`** (**60s** for heavy routes including **`/api/whatsapp-webhook`**; **30s** for **`/api/whatsapp-verify`**).

**Admin “Deployments” card:** set **`VERCEL_API_TOKEN`** and **`VERCEL_PROJECT_ID`** in Vercel env so **`/api/external-status?service=vercel`** can read the latest deployment.

**Admin “GCS Backup” card:** **`/api/external-status?service=gcs`** uses **`@google-cloud/storage`** with **`FIREBASE_SERVICE_ACCOUNT`** to list the **`movie-trailer-site-backups`** bucket and surface the newest export folder (**SUCCESS** if the export is within **48 hours**, **WARNING** if older). Grant the Firebase service account **`storage.objects.list`** on that bucket (for example **Storage Object Viewer**).

### WhatsApp (optional)

In Meta’s app settings, point the webhook to **`https://<your-domain>/api/whatsapp-webhook`**. After **`WHATSAPP_*`** env vars are set, users can open the profile menu → **WhatsApp**, verify a number, pick a default list, and send **IMDb links** on WhatsApp to add titles (same enrichment path as the bookmarklet, server-side). Unregistered numbers get a short reply with a link to the site.

**Webhook security & limits:**

- **`WHATSAPP_APP_SECRET`** is **required** for POST handling. Every POST must include a valid **`x-hub-signature-256`** HMAC of the **raw** body; missing or invalid signature → **403** with **no Firestore access**.
- The handler reads the **raw request stream** (not Vercel’s pre-parsed body) so the HMAC matches Meta’s payload.
- **Per-sender rate limit:** **5** messages per WhatsApp sender per **60** seconds — over the limit returns **200** with no further processing (avoids aggressive Meta retries); events are logged for Axiom as **`whatsapp.rate_limit`**.
- **`src/api-lib/firestore-guard.js`** runs **`checkFirestoreQuota(db, 10)`** before other Firestore work; if quota is exceeded, the user may receive a WhatsApp reply that the service is temporarily unavailable.

### Firestore read quota guard

**`src/api-lib/firestore-guard.js`** enforces configurable **hourly** and **daily** Firestore **read** budgets for selected serverless routes. It reads/writes **`meta/usageStats`** in a transaction (`readsToday`, `readsThisHour`, `lastResetDate`, `lastResetHour`, `updatedAt`). Limits come from **`FIRESTORE_HOURLY_READ_LIMIT`** (default **5000**) and **`FIRESTORE_DAILY_READ_LIMIT`** (default **45000**). Used by **`whatsapp-webhook`**, **`add-from-imdb`**, **`check-upcoming`**, and **`trigger-upcoming-sync`**.

**`/admin`** shows live progress bars (reads this hour / reads today) from **`meta/usageStats`**.

**When quota is exceeded:** the WhatsApp webhook sends a short reply to the sender; **`add-from-imdb`** returns **503**; **`check-upcoming`** records a **skipped** outcome in **`meta/jobConfig`** and returns a skipped JSON payload; **`trigger-upcoming-sync`** returns **503**.

### External services (email & domain)

- **`maulbogat.com`:** personal domain (**Cloudflare** Registrar and DNS). The **watchlist** app is served at **`https://watchlist.maulbogat.com`**: the **`watchlist`** hostname is a **CNAME** to **Vercel** (project still builds from this repo). DNS verified with **Resend** for outbound mail on **`maulbogat.com`**.
- **Resend:** transactional email (invite flow only). Requires **`RESEND_API_KEY`**. Set **`RESEND_FROM_EMAIL`** to a verified sender (e.g. **`noreply@maulbogat.com`**); if unset, the code falls back to Resend’s test sender (**`onboarding@resend.dev`**) for development.

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

6. **Upcoming episodes / movies (optional UI):** Vercel **Cron** invokes **`/api/check-upcoming`** on the schedule in **`vercel.json`** (3:00 UTC) to fill `upcomingAlerts` from **`titleRegistry`** and TMDB. Deploy **`firestore.rules`** so signed-in users can read `upcomingAlerts` and **`titleRegistry`**. The watchlist **Up next** section (see **Features**) renders those alerts as horizontal cards with poster, detail line, gold date, dismiss, and **`.ics`** download when dated. Adding a title via the bookmarklet upserts **`titleRegistry`** and triggers a one-title sync when `tmdbId` is present.

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

Multiple people can use the app with their own Google accounts, but **new** accounts must be **invited** (email invite → **`/join-app/:inviteId`**) or already present in **`allowedUsers`** (e.g. seeded with **`scripts/seed-allowed-users.mjs`**). Each account has its own **personal lists** (default list + optional extra lists in the subcollection). The bookmarklet adds to the **currently selected** list in the main app (personal or shared). Items go only to lists that user is allowed to write (see Firestore rules).

## Shared lists & email invites

**Resend** sends app invitations using **`RESEND_API_KEY`** and a verified domain (**`maulbogat.com`**). A single invite email can combine **app allowlist access** and optional **shared list membership** (one **`POST /api/invites`** `action: send` with optional **`listId`**). Invites **expire after seven days**, are **single-use**, and can be **revoked** (**`DELETE /api/invites`**).

**`verificationCodes/{digits}`** (E.164-style doc id used by **`api/whatsapp-verify.js`**) stores short-lived **WhatsApp link codes** (**15-minute** expiry); Admin SDK only, no client access.

Create shared lists that multiple people can add to and update together:

1. **Create:** Use the list dropdown → "+ Create shared list" → enter a name
2. **Share:** After creation, copy the **`/join/{listId}`** link from the dialog — recipients still need a **pending email invite** for that list (see below)
3. **Invite by email:** Manage lists → **Invite someone** — optional shared list attachment; pending invites can be revoked
4. **Join (link):** Opening **`/join/{listId}`** while signed in calls **`POST /api/join-shared-list`**. The API requires a **valid pending `invites` row** whose **`invitedEmail`** matches the signed-in user and **`listId`** matches the URL — otherwise **403** **`invite_required`**. Accepting an app invite that includes a list grants membership without using this path separately when applicable.
5. **Join (app invite):** **`/join-app/:inviteId`** — sign in, then **`POST /api/invites`** with **`action: "accept"`** to write **`allowedUsers`** and optional shared list membership.
6. **Add items:** When viewing a shared list, the bookmarklet adds to that list (sign in and switch to the shared list first)

Deploy Firestore rules: `firebase deploy --only firestore:rules`

**Verify in Firebase Console:**

1. **Authentication → Sign-in method** → Google → Enabled
2. **Authentication → Settings → Authorized domains** → Add your production host (`watchlist.maulbogat.com`) and `localhost` for local dev
3. **Firestore rules** (in `firestore.rules`) — signed-in users: read/write their **`users/{uid}`** doc and **`users/{uid}/personalLists/*`**; read/write **`sharedLists/{listId}`** only when their uid is in **`members`**; read **`titleRegistry`** and **`upcomingAlerts`** (no client writes there); read their own **`allowedUsers/{email}`** row (document id matches normalized email); read **`invites`** (writes Admin-only). **`syncState`** and **`verificationCodes`** are Admin-only. **`meta/{docId}`**: **read** only for hardcoded **admin UIDs** (aligned with **`src/config/admin.ts`**); **no client writes** (Admin SDK writes **`jobConfig`**, **`usageStats`**, etc.).

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

## Firestore backups

There are **two** backup paths:

The **GitHub Actions** JSON snapshot and the **Google Cloud Storage** native export complement each other: JSON in the repo for search and review, and GCS for scheduled full-database disaster recovery.

1. **JSON snapshot** — local script and/or **GitHub Actions** commit a searchable **`backups/firestore-backup.json`** (see **[`BACKUP.md`](./BACKUP.md)** for the workflow).
2. **Native export (Google Cloud Storage)** — **Cloud Scheduler** job **`firestore-daily-export`** runs daily at **4:00 UTC** and writes Firestore export output to bucket **`movie-trailer-site-backups`** (**europe-west1**), authenticated with **OAuth** via the **`firestore-scheduler`** service account. A **30-day** lifecycle rule removes objects older than **30 days**. Open the bucket and scheduler from **Admin → Service Links** (**Google Cloud Storage**, **Cloud Scheduler**) or the GCP console.

### Export Firestore to JSON (inspect / `grep` / `rg`)

Pull **titleRegistry**, **upcomingAlerts**, **sharedLists**, **users**, **allowedUsers**, **invites**, **phoneIndex**, **upcomingChecks**, and each user’s **personalLists** subcollection into one file:

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
- **Catalog not on any list** (`titleRegistry` docs never referenced as `registryId` on a list): `node -r dotenv/config scripts/catalog-not-on-any-list.mjs`
- **Backfill `tmdbMedia` from `type`** (fixed doc list; no TMDB call): `node scripts/backfill-tmdb-media.mjs` (dry run) then `node scripts/backfill-tmdb-media.mjs --write`
- **Remove legacy attribution fields** (`addedByUid`, `addedByDisplayName`, `addedByPhotoUrl` on fixed `titleRegistry` docs): `node scripts/cleanup-legacy-fields.mjs` then `node scripts/cleanup-legacy-fields.mjs --write`
- **Backfill missing posters** (`thumb` from TMDB for a fixed doc list; needs `TMDB_API_KEY` in `.env`): `node scripts/backfill-thumb.mjs` then `node scripts/backfill-thumb.mjs --write`
- **Add by IMDb id** (TMDB enrichment): `node scripts/add-title-by-imdb.js tt12345678`
- **Delete legacy `catalog` collection** (after migration): `node scripts/delete-legacy-catalog.mjs --write`

**Local diagnostics** (Admin + `.env` / `serviceAccountKey.json`; see each file’s header for env vars):

- **Upcoming alerts vs TMDB** (read-only report): `node check-upcoming.mjs`
- **TMDB vs Trakt “next episode”** (read-only): `node compare-upcoming-trakt.mjs`

Many scripts expect **`TMDB_API_KEY`**, **`FIREBASE_SERVICE_ACCOUNT`** (base64) or **`serviceAccountKey.json`**, and often **`dotenv`** — e.g. `node -r dotenv/config scripts/...`.

## Features

- **Watchlist UI (React):** grid of titles with poster, status controls, and **trailer modal** (YouTube embed; **add-to-list** checkmarks stay in sync with list mutations via React Query). **Skeleton placeholders** for the grid and filter chrome while list data loads.
- **Up next:** horizontal **card row** (poster thumbnail, title, episode/release detail, **date in gold**, dismiss, **calendar (`.ics`)** download) for the current list’s **`upcomingAlerts`**. Shows the **first four** titles in a scrollable strip; **expand** reveals a full **grid** with **Show less** to collapse. **Skeleton strip** while alerts load. Section **hidden** when there are no alerts. **`localStorage`** + TanStack Query (**2-hour** stale window) reduce redundant Firestore reads.
- **Sticky controls toolbar:** after the header and Up next block, the filter toolbar **sticks** to the top of the viewport (**IntersectionObserver** + **`styles.css`** sticky shell).
- **Personal lists:** default list + extra lists; **manage lists** modal (create/rename/delete, pick default, **invite someone** + pending invites).
- **Shared lists:** create; share **`/join/:listId`** from the post-create dialog (**join still requires a matching email invite**); optional list on the same email as app access; bookmarklet targets the list you’re viewing.
- **App access:** **`allowedUsers`** + **`/join-app/:inviteId`**; profile menu **Bookmarklet** dialog (instructions + drag button; moved out of manage lists).
- **WhatsApp adds:** verified numbers and per-number default list (**`phoneIndex`** + **`users/{uid}.phoneNumbers`**); inbound messages handled by **`/api/whatsapp-webhook`** (signature, rate limit, and quota guard — see **Vercel deployment**).
- **Admin (`/admin`, admin users only):** **header** link **Switch to prod** / **Switch to local** (opens the other admin URL in a new tab; prod target uses **`VITE_APP_ORIGIN`**), **ACTIVITY (LAST 24H)** from Axiom (**`/api/external-status?service=axiom`**, dataset **`watchlist-prod`**), **SENTRY — LAST 24H** unresolved issue count (**`?service=sentry`**, needs **`SENTRY_READ_TOKEN`** + **`SENTRY_PROJECT`**), Firestore read **quota usage** bars, **Data Quality** stats (optional **`meta/catalogHealthExclusions`** doc with **`missingTmdbId`** array to omit known no-TMDB titles from missing-`tmdbId` counts/lists), catalog/upcoming stats, upcoming job toggle, GitHub backup workflow status, and **Service Links** (Firebase, **Vercel env vars**, **Meta WhatsApp** dev console, **Google Cloud** billing + **project dashboard** + **Cloud Storage** backup bucket + **Cloud Scheduler** (Firestore export job), GitHub, TMDB, Trakt, etc.).
- **Status tabs:** **All**, **To Watch** (**includes “maybe later”** rows), **Watched**, **Archive** — persisted in Firestore. **Recently Added** is no longer a separate tab; use **sort** options **Date Added (New → Old)** and **Date Added (Old → New)**.
- **Filters:** Movies / TV / Both (segmented), **genre** as a **single-select list** (Radix Popover, two-row toolbar with **Added by** on **shared lists only**), persisted per account in **localStorage** (with session restore).
- **Country / region:** set in app for TMDB **watch providers** at add time; **service chips** on cards (e.g. Netflix, Prime).
- **Hover-only card actions (desktop):** remove and status controls stay hidden until **hover** or keyboard focus inside the card (**`@media (hover: hover)`**); touch devices keep controls available without hover.
- **Bookmarklet:** add from **imdb.com** via **`add.html`** + **`/api/add-from-imdb`**.
- **Google sign-in:** same Firebase project as production; remember **authorized domains** for each host/port you use locally.
