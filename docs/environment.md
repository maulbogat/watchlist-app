# Environment variables (checklist)

**Hosting: Vercel** — static app from **`dist/`** plus serverless **`api/*`** (see **`vercel.json`**). Configure values in the dashboard: **Project → Settings → [Environment Variables](https://vercel.com/docs/projects/environment-variables)**. This repo cannot change the dashboard; use this file as the checklist for **which** keys exist, **where** they apply (Vite build vs serverless runtime), and **why**.

**Production URL:** **`https://watchlist.maulbogat.com`**. **Cloudflare** manages the **`maulbogat.com`** zone; the **`watchlist`** subdomain is a **CNAME** to this **Vercel** project. Optional **`VITE_APP_ORIGIN`** should match that origin if set; **`src/pages/AdminPage.tsx`** uses **`https://watchlist.maulbogat.com`** as the built-in default when it is unset.

## Client bundle vs server secrets

During **`npm run build:react`**, Vite replaces **`import.meta.env.VITE_*`** and embeds those values into **`dist/`**. Anything prefixed with **`VITE_` ships to browsers** — do not put private API tokens, Axiom credentials, or Firebase service account material there.

## 1. Delete these (required)

| Variable | Reason |
|----------|--------|
| **`VITE_AXIOM_TOKEN`** | Unused. Client logging goes to **`/api/log-client-event`** using server-only **`AXIOM_TOKEN`** / **`AXIOM_DATASET`**. A `VITE_*` copy would land in **`dist/`** and duplicates server secrets. |
| **`VITE_AXIOM_DATASET`** | Same as above. |

## 2. Client / Vite (Vercel build step)

These must be defined for each **Vercel environment** where you run a production-quality front-end build — at minimum **Production**. Also add them to **Preview** (and **Development** if you use it) when those deployments should render a working SPA.

Vercel injects matching variables into the **build** process. They are compiled into static assets; they are not “hidden” on the server.

| Variable | Required | Notes |
|----------|----------|-------|
| `VITE_FIREBASE_API_KEY` | Yes | Firebase web SDK |
| `VITE_FIREBASE_AUTH_DOMAIN` | Yes | |
| `VITE_FIREBASE_PROJECT_ID` | Yes | |
| `VITE_FIREBASE_STORAGE_BUCKET` | Yes | |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | Yes | |
| `VITE_FIREBASE_APP_ID` | Yes | |
| `VITE_FIREBASE_MEASUREMENT_ID` | No | Analytics |
| `VITE_APP_VERSION` | No | Shown in client logs |
| `VITE_APP_ORIGIN` | No | Admin header prod/local switch and related fallbacks; override if needed (code default **`https://watchlist.maulbogat.com`**) |
| `VITE_DEPLOYMENTS_URL` | No | Admin “Deployments” card link |
| `VITE_SITE_ID` | No | Optional; **`admin-env-status`** reports whether a site id is configured (not a secret) |
| `VITE_SENTRY_DSN` | No | **Sentry** browser SDK — **`src/main.tsx`**; no-op if unset; production-only when set (**`import.meta.env.PROD`**). User context: Firebase **`uid` only** (no email or display name). |

**Optional Vite / CI (production build only):** when **`SENTRY_AUTH_TOKEN`** is set, **`vite.config.ts`** enables **`@sentry/vite-plugin`** and **`build.sourcemap`** so maps upload to Sentry; also set **`SENTRY_ORG`** and **`SENTRY_PROJECT`**. Omit locally if you do not upload source maps.

## 3. Server / serverless only (never `VITE_*` for secrets)

Read at **runtime** by **`api/*.js`** on Vercel (and by **`vercel dev`** / local Node scripts). In the dashboard, enable them for **Production** and, if needed, **Preview**. Use Vercel’s **Sensitive** option for credentials so values are not echoed in build logs where supported — see [Sensitive environment variables](https://vercel.com/docs/projects/environment-variables#sensitive-environment-variables).

| Variable | Purpose |
|----------|---------|
| `FIREBASE_SERVICE_ACCOUNT` | Base64 JSON — Firebase Admin SDK in API routes; also used by **`/api/external-status?service=gcs`** (**`@google-cloud/storage`**) if that account can list **`movie-trailer-site-backups`** |
| `FIRESTORE_HOURLY_READ_LIMIT` | Optional — default **5000**; `checkFirestoreQuota` blocks when estimated reads would exceed this in the current UTC hour (`meta/usageStats`) |
| `FIRESTORE_DAILY_READ_LIMIT` | Optional — default **45000**; same guard for UTC calendar day |
| `TMDB_API_KEY` | `check-upcoming`, `trigger-upcoming-sync`, `add-from-imdb`, `catalog-health`, scripts |
| `OMDB_API_KEY` | `add-from-imdb` |
| `AXIOM_TOKEN` | Server-side Axiom ingest (`log-client-event`, function loggers) and **`GET /api/external-status?service=axiom`** (Admin **Activity** APL query on **`watchlist-prod`**) |
| `AXIOM_DATASET` | Axiom dataset name (ingest target in **`src/api-lib/logger.js`**; Admin activity query uses dataset **`watchlist-prod`** in APL, not this env var) |
| `SENTRY_DSN` | Optional — **`api/add-from-imdb.js`** and **`api/whatsapp-webhook.js`** only (**`src/api-lib/sentry-node.js`**); no-op if unset |
| `SENTRY_READ_TOKEN` | Optional — **`GET /api/external-status?service=sentry`** (Admin **SENTRY — LAST 24H** card); Sentry API auth with **read** scope; **503** on that route if unset |
| `SENTRY_PROJECT` | Optional — same route — Sentry **project slug** under org **`maulbogat`** (issues list path). Unset → **`{ ok: false, error }`** (not **503**) |
| `UPCOMING_SYNC_TRIGGER_SECRET` | Optional — bearer auth for **`/api/trigger-upcoming-sync`** |
| `GITHUB_TOKEN` | Optional — **`/api/external-status?service=github`** (private repo or higher GitHub API rate limits) |
| `GITHUB_REPO` | Optional — override `owner/repo` for backup workflow discovery; **`/api/external-status?service=github`** defaults to **`maulbogat/watchlist-app`** when unset |
| `VERCEL_API_TOKEN` | **`/api/external-status?service=vercel`** — Vercel API bearer token (Admin deployments card) |
| `VERCEL_PROJECT_ID` | Same route — Vercel **Project ID** (Settings → General). Both `VERCEL_*` required or the route returns **503** |
| `WHATSAPP_VERIFY_TOKEN` | **`/api/whatsapp-webhook`** — Meta webhook verification (GET) |
| `WHATSAPP_APP_SECRET` | Meta **App Secret** — **`/api/whatsapp-webhook`** POST verifies `X-Hub-Signature-256` (HMAC over the **raw** JSON body; the handler reads the Node request stream so bytes match what Meta signed on Vercel) |
| `WHATSAPP_TOKEN` | WhatsApp Cloud API — outbound messages (`whatsapp-verify`, `whatsapp-webhook`) |
| `WHATSAPP_PHONE_NUMBER_ID` | Cloud API **Phone number ID** for sends |
| `APP_PUBLIC_URL` | Optional — canonical site URL. **Invites** (`api/invites.js`): email links default to **`https://watchlist.maulbogat.com`** when unset (no `VERCEL_URL` fallback there). **WhatsApp** (`whatsapp-webhook` `publicAppBaseUrl`): **`APP_PUBLIC_URL`** → **`VITE_APP_ORIGIN`** → **`VERCEL_URL`** (`https://…`) → **`https://watchlist.maulbogat.com`**. |
| `RESEND_API_KEY` | **`/api/invites`** (POST `action: send`) — [Resend](https://resend.com) API key for invitation emails |
| `RESEND_FROM_EMAIL` | Optional — `From:` for invite mail; defaults to **`onboarding@resend.dev`** (Resend shared testing domain) when unset |

Some routes also read **`VITE_APP_ORIGIN`** from **`process.env`** when present (e.g. WhatsApp copy); the SPA normally supplies it via the Vite build only.

## 4. Local development (parity with production)

| What | File |
|------|------|
| **`VITE_*`** | **`.env.local`** (Vite; gitignored) |
| **Server / script keys** | **`.env`** at repo root ( **`vercel dev`**, Node scripts; gitignored) |

Keep **names identical** to Vercel so behavior matches.

- **`npm run dev:react`** — loads **`.env.local`**; proxies **`/api/*`** to **`vercel dev`** (see **`vite.config.ts`**, typically **http://localhost:3000**).
- **`vercel dev`** (repo root) — serves **`api/*.js`** with project environment rules; use it alongside Vite when you need bookmarklet, WhatsApp verify, cron handlers, or Axiom logging locally.

## 5. Feature → variables

| Feature | Needs |
|---------|-------|
| **Production / preview SPA** | §2 **`VITE_*`** for that Vercel environment |
| **Bookmarklet / `add-from-imdb`** | `FIREBASE_SERVICE_ACCOUNT`, `OMDB_API_KEY`, `TMDB_API_KEY` |
| **Scheduled / manual upcoming sync** | `TMDB_API_KEY`, `FIREBASE_SERVICE_ACCOUNT`, deployed Firestore rules |
| **Client → Axiom** | `AXIOM_*`, `FIREBASE_SERVICE_ACCOUNT` (token verification on **`log-client-event`**) |
| **Admin job config** (`checkUpcomingEnabled`, `githubBackupEnabled`) | `FIREBASE_SERVICE_ACCOUNT` — **`/api/admin-job-config`** (Firebase ID token + admin UID) |
| **Admin Axiom activity (24h)** | `AXIOM_TOKEN` — **`/api/external-status?service=axiom`** (dataset **`watchlist-prod`** in APL) |
| **WhatsApp link + inbound messages** | `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` |
| **Email app invites** | `RESEND_API_KEY`, `FIREBASE_SERVICE_ACCOUNT`; optional **`APP_PUBLIC_URL`** (code default **`https://watchlist.maulbogat.com`**); optional `RESEND_FROM_EMAIL` — **`/api/invites`** |
| **Admin GitHub backup status** | `GITHUB_TOKEN` optional for public repo; often required for private — **`/api/external-status?service=github`** |
| **Admin Vercel deployment status** | `VERCEL_API_TOKEN`, `VERCEL_PROJECT_ID` — **`/api/external-status?service=vercel`** |
| **Admin GCS backup status** | `FIREBASE_SERVICE_ACCOUNT` — **`/api/external-status?service=gcs`**; IAM on **`movie-trailer-site-backups`** must allow **`storage.objects.list`** for that service account |
| **GCS Firestore native export** (bucket **`movie-trailer-site-backups`**, Scheduler **`firestore-daily-export`**) | **None** in app env for the scheduled job itself — IAM, lifecycle, and job live in Google Cloud; the **Admin** card reuses **`FIREBASE_SERVICE_ACCOUNT`** as above. |
| **Sentry (errors)** | Optional **`VITE_SENTRY_DSN`** (client) + optional **`SENTRY_DSN`** (two API routes); optional **`SENTRY_READ_TOKEN`** + **`SENTRY_PROJECT`** (Admin issues count); optional **`SENTRY_AUTH_TOKEN`**, **`SENTRY_ORG`**, **`SENTRY_PROJECT`** for build-time source map upload |

Nothing in the app expects **`VITE_AXIOM_*`**.
