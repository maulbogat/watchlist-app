# Environment variables (checklist)

**Hosting: Vercel** — static app from **`dist/`** plus serverless **`api/*`** (see **`vercel.json`**). Configure values in the dashboard: **Project → Settings → [Environment Variables](https://vercel.com/docs/projects/environment-variables)**. This repo cannot change the dashboard; use this file as the checklist for **which** keys exist, **where** they apply (Vite build vs serverless runtime), and **why**.

## Client bundle vs server secrets

During **`npm run build:react`**, Vite replaces **`import.meta.env.VITE_*`** and embeds those values into **`dist/`**. Anything prefixed with **`VITE_` ships to browsers** — do not put private API tokens, Axiom credentials, or Firebase service account material there.

**Optional legacy Admin badge:** **`VITE_NETLIFY_SITE_ID`** only affects an optional Netlify deploy badge in the client. That UUID is already public in standard badge URLs; treat it as non-secret UI configuration, not as protection for server access.

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
| `VITE_APP_ORIGIN` | No | Admin service links / bookmarklet base URL override |
| `VITE_DEPLOYMENTS_URL` | No | Admin “Deployments” card link |
| `VITE_SITE_ID` | No | Optional; **`admin-env-status`** reports whether a site id is configured (not a secret) |
| `VITE_NETLIFY_SITE_ID` | No | Legacy only — Admin Netlify deploy badge |
| `VITE_NETLIFY_PROJECT_SLUG` | No | Legacy only — Netlify deploys URL slug |

## 3. Server / serverless only (never `VITE_*` for secrets)

Read at **runtime** by **`api/*.js`** on Vercel (and by **`vercel dev`** / local Node scripts). In the dashboard, enable them for **Production** and, if needed, **Preview**. Use Vercel’s **Sensitive** option for credentials so values are not echoed in build logs where supported — see [Sensitive environment variables](https://vercel.com/docs/projects/environment-variables#sensitive-environment-variables).

| Variable | Purpose |
|----------|---------|
| `FIREBASE_SERVICE_ACCOUNT` | Base64 JSON — Firebase Admin SDK in API routes |
| `FIRESTORE_HOURLY_READ_LIMIT` | Optional — default **5000**; `checkFirestoreQuota` blocks when estimated reads would exceed this in the current UTC hour (`meta/usageStats`) |
| `FIRESTORE_DAILY_READ_LIMIT` | Optional — default **45000**; same guard for UTC calendar day |
| `TMDB_API_KEY` | `check-upcoming`, `trigger-upcoming-sync`, `add-from-imdb`, scripts |
| `OMDB_API_KEY` | `add-from-imdb` |
| `AXIOM_TOKEN` | Server-side Axiom ingest (`log-client-event`, function loggers) |
| `AXIOM_DATASET` | Axiom dataset name |
| `UPCOMING_SYNC_TRIGGER_SECRET` | Optional — bearer auth for **`/api/trigger-upcoming-sync`** |
| `GITHUB_TOKEN` | Optional — **`/api/github-backup-status`** (private repo or higher GitHub API rate limits) |
| `GITHUB_REPO` | Optional — override `owner/repo` for backup workflow discovery |
| `WHATSAPP_VERIFY_TOKEN` | **`/api/whatsapp-webhook`** — Meta webhook verification (GET) |
| `WHATSAPP_TOKEN` | WhatsApp Cloud API — outbound messages (`whatsapp-verify`, `whatsapp-webhook`) |
| `WHATSAPP_PHONE_NUMBER_ID` | Cloud API **Phone number ID** for sends |
| `APP_PUBLIC_URL` | Optional — canonical site URL in WhatsApp replies and **email invite links**; **`VERCEL_URL`** used if unset |
| `RESEND_API_KEY` | **`/api/invites`** (POST `action: send`) — [Resend](https://resend.com) API key for invitation emails |
| `RESEND_FROM_EMAIL` | Optional — `From:` for invite mail; defaults to **`onboarding@resend.dev`** (Resend shared testing domain) when unset |
| `NETLIFY_SITE_ID` | Optional legacy — **`admin-env-status`** fallback; **avoid** setting the same value as a “secret” elsewhere if it already appears verbatim inside **`dist/`** (e.g. duplicated Netlify site UUID) |

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
| **Admin Netlify badge (legacy)** | `VITE_NETLIFY_SITE_ID` |
| **WhatsApp link + inbound messages** | `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` |
| **Email app invites** | `RESEND_API_KEY`, `FIREBASE_SERVICE_ACCOUNT`, `APP_PUBLIC_URL` (or `VERCEL_URL`); optional `RESEND_FROM_EMAIL` — all via **`/api/invites`** |
| **Admin GitHub backup status** | `GITHUB_TOKEN` optional for public repo; often required for private |

Nothing in the app expects **`VITE_AXIOM_*`**.
