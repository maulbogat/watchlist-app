# Netlify environment variables (checklist)

Apply these in **Netlify → Site configuration → Environment variables**. The Git repo cannot edit the dashboard; use this file as the source of truth.

## Secret scanning: Site ID vs `dist/`

Netlify compares **values of variables marked “secret”** to your **repo and `dist/`** output.

- **`VITE_NETLIFY_SITE_ID`** is inlined into the client JS (Admin badge URL). The Site ID UUID is **public** (also in Netlify badge URLs).
- If you **also** set **`NETLIFY_SITE_ID`** to the **same UUID** and mark it **secret**, the build **fails**: that string appears in `dist/assets/main-*.js`.

**Fix:** Use **only `VITE_NETLIFY_SITE_ID`** in Netlify (scope includes **Builds** and **Functions**). **Remove** `NETLIFY_SITE_ID` **or** uncheck “Contains secret values” if you keep it. Functions that need the site UUID read `VITE_NETLIFY_SITE_ID` first, then `NETLIFY_SITE_ID`.

Do **not** mark **`VITE_NETLIFY_SITE_ID`** as a secret (it is always in the bundle).

## 1. Delete these (required)

| Variable | Reason |
|----------|--------|
| **`VITE_AXIOM_TOKEN`** | Unused. Vite can embed `VITE_*` into `dist/`; [secret scanning](https://docs.netlify.com/manage/security/secret-scanning/) fails if values overlap server secrets. |
| **`VITE_AXIOM_DATASET`** | Same. Client logging uses **`/.netlify/functions/log-client-event`** with server-only **`AXIOM_TOKEN`** / **`AXIOM_DATASET`**. |

## 2. Client / Vite (`npm run build:react`)

These must be available **during the build** (Vite inlines `VITE_*` into the browser bundle).

**Scopes in Netlify:** use **All scopes** or any option that **includes Builds** and **Functions** (so serverless functions can read the same `VITE_NETLIFY_SITE_ID` when needed).

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
| `VITE_NETLIFY_SITE_ID` | No | Admin deploy badge (not a secret — appears in `dist/`) |
| `VITE_NETLIFY_PROJECT_SLUG` | No | Only if the Netlify project slug ≠ default in code |

## 3. Server / functions only (never `VITE_*`)

Used by **`netlify/functions/*.js`** (bookmarklet, jobs, `log-client-event`, etc.).

**Scopes:** Prefer **Functions** (+ **Runtime** if your plan lists it) and **omit Builds** if Netlify lets you scope per variable—so secrets are not loaded into the Vite build step. If your UI only offers **Builds, Functions, Runtime** together, that still works; deleting **`VITE_AXIOM_*`** is the critical fix.

Mark sensitive values as **Contains secret values** in Netlify.

| Variable | Purpose |
|----------|---------|
| `FIREBASE_SERVICE_ACCOUNT` | Base64 service account JSON — Admin SDK in functions |
| `TMDB_API_KEY` | `check-upcoming`, `trigger-upcoming-sync`, `add-from-imdb`, scripts |
| `OMDB_API_KEY` | `add-from-imdb` |
| `AXIOM_TOKEN` | Server-side Axiom ingest (logger, `log-client-event`) |
| `AXIOM_DATASET` | Dataset name for ingest |
| `NETLIFY_SITE_ID` | **Avoid** if duplicate of `VITE_NETLIFY_SITE_ID` (see § top). Optional legacy fallback only. |
| `UPCOMING_SYNC_TRIGGER_SECRET` | Optional — auth for `trigger-upcoming-sync` |

## 4. Local development (parity with prod)

| What | File |
|------|------|
| **`VITE_*`** (Firebase, `VITE_APP_VERSION`, `VITE_NETLIFY_*`) | **`.env.local`** (Vite) |
| **Server keys** (`TMDB_*`, `OMDB_*`, `FIREBASE_SERVICE_ACCOUNT`, `AXIOM_*`, optional `UPCOMING_*`) | **`.env`** (Node / `netlify dev` / `netlify functions:serve`) |

`VITE_NETLIFY_SITE_ID` lives in **`.env.local`**; Netlify functions can read the same value when env is scoped to **Functions**.

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
| **Admin deploy badge** | `VITE_NETLIFY_SITE_ID` |

No code path requires **`VITE_AXIOM_*`**.
