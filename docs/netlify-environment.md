# Environment variables (checklist)

**Production hosting is Vercel** (`api/*`, `vercel.json`). Apply these in **Vercel → Project → Settings → Environment variables** (or legacy Netlify if you still mirror there). The Git repo cannot edit the dashboard; use this file as the source of truth.

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
| **`VITE_AXIOM_DATASET`** | Same. Client logging uses **`/api/log-client-event`** with server-only **`AXIOM_TOKEN`** / **`AXIOM_DATASET`**. |

## 2. Client / Vite (`npm run build:react`)

These must be available **during the build** (Vite inlines `VITE_*` into the browser bundle).

**Scopes in Netlify (important for the Lambda 4KB limit — see §6):**

- **`VITE_FIREBASE_*`**, **`VITE_APP_VERSION`**, **`VITE_FIREBASE_MEASUREMENT_ID`**, **`VITE_NETLIFY_PROJECT_SLUG`**: scope **Builds** only. No function in this repo reads them at runtime; if they are also scoped to **Functions**, Netlify duplicates their values into every Lambda and you can hit AWS’s **4096-byte** env limit.
- **`VITE_NETLIFY_SITE_ID`**: scope **Builds** and **Functions**. The build inlines it into `dist/`; **`admin-env-status`** checks it in the function environment (tiny UUID).

| Variable | Required | Notes |
|----------|----------|--------|
| `VITE_FIREBASE_API_KEY` | Yes | Builds only |
| `VITE_FIREBASE_AUTH_DOMAIN` | Yes | Builds only |
| `VITE_FIREBASE_PROJECT_ID` | Yes | Builds only |
| `VITE_FIREBASE_STORAGE_BUCKET` | Yes | Builds only |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | Yes | Builds only |
| `VITE_FIREBASE_APP_ID` | Yes | Builds only |
| `VITE_FIREBASE_MEASUREMENT_ID` | No | Analytics; Builds only |
| `VITE_APP_VERSION` | No | Shown in client logs; Builds only |
| `VITE_NETLIFY_SITE_ID` | No | Admin deploy badge; **Builds + Functions** |
| `VITE_NETLIFY_PROJECT_SLUG` | No | Builds only if set |

## 3. Server / functions only (never `VITE_*`)

Used by **`api/*.js`** (bookmarklet, jobs, `log-client-event`, etc.).

**Scopes:** Prefer **Functions** only for secrets that functions read (and **Builds** only when an `npm run build` script needs the same key—rare here). Do **not** add **Functions** scope to **`VITE_FIREBASE_*`** / **`VITE_APP_VERSION`** (see §2 and §6).

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
| `WHATSAPP_VERIFY_TOKEN` | `whatsapp-webhook` — Meta subscription GET |
| `WHATSAPP_TOKEN` | Sending messages / Graph API (when implemented) |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp phone number id (when implemented) |

## 4. Local development (parity with prod)

| What | File |
|------|------|
| **`VITE_*`** (Firebase, `VITE_APP_VERSION`, `VITE_NETLIFY_*`) | **`.env.local`** (Vite) |
| **Server keys** (`TMDB_*`, `OMDB_*`, `FIREBASE_SERVICE_ACCOUNT`, `AXIOM_*`, optional `UPCOMING_*`) | **`.env`** (Node / `netlify dev` / `netlify functions:serve`) |

`VITE_NETLIFY_SITE_ID` lives in **`.env.local`**; Netlify functions can read the same value when env is scoped to **Functions**.

Copy **the same variable names** as in Netlify; values come from your machine.

- **`npm run dev:react`** — reads `.env.local`; proxies **`/api`** to **`vercel dev`** on port **3000** (`vite.config.ts`).
- **`netlify dev`** (recommended) — loads both and runs the app + functions together **or** run **`netlify dev`** / **`netlify functions:serve`** on **8888** alongside Vite.

## 5. What still works after cleanup

| Feature | Needs |
|---------|--------|
| **Production / preview builds** | All **`VITE_*`** in §2 |
| **Bookmarklet (`add-from-imdb`)** | `FIREBASE_SERVICE_ACCOUNT`, `OMDB_API_KEY`, `TMDB_*` |
| **Scheduled / manual upcoming sync** | `TMDB_API_KEY`, `FIREBASE_SERVICE_ACCOUNT`, Firestore rules |
| **Client → Axiom logs** | `AXIOM_*` + `FIREBASE_SERVICE_ACCOUNT` (`log-client-event` verifies Firebase ID tokens) |
| **Admin deploy badge** | `VITE_NETLIFY_SITE_ID` |
| **WhatsApp webhook** | `WHATSAPP_VERIFY_TOKEN` (+ token / phone id when sending) |

No code path requires **`VITE_AXIOM_*`**.

## 6. Deploy fails: “environment variables exceed the 4KB limit” (AWS Lambda)

Netlify uploads each function with **every environment variable whose scope includes Functions**. The **combined** size of names and values must stay under **4096 bytes** per Lambda.

**What usually breaks it:** a large **`FIREBASE_SERVICE_ACCOUNT`** (base64 service account JSON is often **2.5–4KB** on its own) **plus** extra keys duplicated into Functions—especially **`VITE_FIREBASE_*`** and **`VITE_APP_VERSION`** if they were set to **All scopes** or **Functions**.

**Fix (Netlify → Environment variables → edit each row → Scopes):**

1. Set **`VITE_FIREBASE_*`**, **`VITE_APP_VERSION`**, **`VITE_FIREBASE_MEASUREMENT_ID`**, **`VITE_NETLIFY_PROJECT_SLUG`** to **Builds** only (remove **Functions**).
2. Set **`VITE_NETLIFY_SITE_ID`** to **Builds** and **Functions** (see §2).
3. Keep **`FIREBASE_SERVICE_ACCOUNT`**, **`TMDB_API_KEY`**, **`OMDB_API_KEY`**, **`AXIOM_*`**, **`WHATSAPP_*`**, **`UPCOMING_SYNC_TRIGGER_SECRET`**, **`GITHUB_*`** on **Functions** (add **Builds** only if something in `npm run build` reads them—it does not for this repo).

Trigger a **new deploy** after saving. If you are still over the limit, the service account blob is the remainder: confirm you are not base64-encoding unnecessary whitespace or a duplicated JSON; as a last resort, create a **dedicated minimal Firebase service account** (same JSON layout, not much smaller) or contact Netlify about limits on your plan.
