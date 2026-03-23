# Netlify environment variables (checklist)

Apply these in **Netlify → Site configuration → Environment variables**. The Git repo cannot edit the dashboard; use this file as the source of truth.

## 1. Delete these (required)

| Variable | Reason |
|----------|--------|
| **`VITE_AXIOM_TOKEN`** | Unused. Vite can embed `VITE_*` into `dist/`; [secret scanning](https://docs.netlify.com/manage/security/secret-scanning/) fails if values overlap server secrets. |
| **`VITE_AXIOM_DATASET`** | Same. Client logging uses **`/.netlify/functions/log-client-event`** with server-only **`AXIOM_TOKEN`** / **`AXIOM_DATASET`**. |

## 2. Client / Vite (`npm run build:react`)

These must be available **during the build** (Vite inlines `VITE_*` into the browser bundle).

**Scopes in Netlify:** use **All scopes** or any option that **includes Builds** and your production / preview contexts.

| Variable | Required | Notes |
|----------|----------|--------|
| `VITE_FIREBASE_API_KEY` | Yes | |
| `VITE_FIREBASE_AUTH_DOMAIN` | Yes | |
| `VITE_FIREBASE_PROJECT_ID` | Yes | |
| `VITE_FIREBASE_STORAGE_BUCKET` | Yes | |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | Yes | |
| `VITE_FIREBASE_APP_ID` | Yes | |
| `VITE_FIREBASE_MEASUREMENT_ID` | No | Analytics |
| `VITE_APP_VERSION` | No | Shown in client logs |
| `VITE_NETLIFY_SITE_ID` | No | Admin → **Last deployment** badge; **same UUID** as `NETLIFY_SITE_ID` |
| `VITE_NETLIFY_PROJECT_SLUG` | No | Only if the Netlify project slug ≠ default in code |

## 3. Server / functions only (never `VITE_*`)

Used by **`netlify/functions/*.js`** (bookmarklet, jobs, `log-client-event`, `latest-deploy-status`, etc.).

**Scopes:** Prefer **Functions** (+ **Runtime** if your plan lists it) and **omit Builds** if Netlify lets you scope per variable—so secrets are not loaded into the Vite build step. If your UI only offers **Builds, Functions, Runtime** together, that still works; deleting **`VITE_AXIOM_*`** is the critical fix.

Mark sensitive values as **Contains secret values** in Netlify.

| Variable | Purpose |
|----------|---------|
| `FIREBASE_SERVICE_ACCOUNT` | Base64 service account JSON — Admin SDK in functions |
| `TMDB_API_KEY` | `check-upcoming`, `trigger-upcoming-sync`, `add-from-imdb`, scripts |
| `OMDB_API_KEY` | `add-from-imdb` |
| `AXIOM_TOKEN` | Server-side Axiom ingest (logger, `log-client-event`) |
| `AXIOM_DATASET` | Dataset name for ingest |
| `NETLIFY_API_TOKEN` | Personal access token — **`latest-deploy-status`** (Admin deploy details) |
| `NETLIFY_SITE_ID` | Same UUID as **`VITE_NETLIFY_SITE_ID`** — deploy API (server only) |
| `UPCOMING_SYNC_TRIGGER_SECRET` | Optional — auth for `trigger-upcoming-sync` |

## 4. Local development (parity with prod)

| What | File |
|------|------|
| **`VITE_*`** (Firebase, `VITE_APP_VERSION`, `VITE_NETLIFY_*`) | **`.env.local`** (Vite) |
| **Server keys** (`TMDB_*`, `OMDB_*`, `FIREBASE_SERVICE_ACCOUNT`, `AXIOM_*`, `NETLIFY_*`, `UPCOMING_*`) | **`.env`** (Node / `netlify dev` / `netlify functions:serve`) |

Copy **the same variable names** as in Netlify; values come from your machine.

- **`npm run dev:react`** — reads `.env.local`; proxies `/.netlify/functions` to port **8888** (`vite.config.ts`).
- **`netlify dev`** (recommended) — loads both and runs the app + functions together **or** run **`netlify dev`** / **`netlify functions:serve`** on **8888** alongside Vite.

## 5. What still works after cleanup

| Feature | Needs |
|---------|--------|
| **Production / preview builds** | All **`VITE_*`** in §2 |
| **Bookmarklet (`add-from-imdb`)** | `FIREBASE_SERVICE_ACCOUNT`, `OMDB_API_KEY`, `TMDB_*` |
| **Scheduled / manual upcoming sync** | `TMDB_API_KEY`, `FIREBASE_SERVICE_ACCOUNT`, Firestore rules |
| **Client → Axiom logs** | `AXIOM_*` + `FIREBASE_SERVICE_ACCOUNT` (`log-client-event` verifies Firebase ID tokens) |
| **Admin deploy badge + failure text** | `VITE_NETLIFY_SITE_ID`, `NETLIFY_API_TOKEN`, `NETLIFY_SITE_ID` |

No code path requires **`VITE_AXIOM_*`**.
