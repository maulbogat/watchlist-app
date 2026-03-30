# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Watchlist** — a full-stack web app for managing personal and shared movie/TV watchlists with YouTube trailers. Users add titles via an IMDb bookmarklet; metadata is fetched from TMDB/OMDb and stored in Firestore. Two users: Roy (admin) and his wife.

**Stack:** React 19 + TypeScript + Vite 6 · Vercel Serverless Functions · Firebase Firestore + Auth · Zustand + TanStack Query · Tailwind CSS 4 + shadcn/ui · Vitest · ESLint 9 + Prettier · Sonner (toasts) · Axiom (observability) · Sentry (error tracking)

**Production:** https://watchlist.maulbogat.com  
**GitHub:** https://github.com/maulbogat/watchlist  
**Vercel project:** watchlist  
**Firebase project ID:** movie-trailer-site (cannot be renamed — legacy identifier)  
**GCS bucket:** movie-trailer-site-backups (cannot be renamed — legacy identifier)

## ⚠️ Critical Rules

- **Never run `vercel --prod`** without explicit user approval — this deploys to production
- **Never mark a Notion task as Done** without explicit user approval
- **Never modify `firestore.rules`** without explicit user approval
- **Always run `npm run typecheck` and `npm run build:react`** before considering any task complete
- **`.cursorrules`** is the source of truth for coding standards — this project uses both Cursor and Claude Code; keep them aligned

## Commands

```bash
# Development (requires two terminals)
npm run dev:react          # Vite dev server, port 5173
vercel dev --listen 3000   # Serverless API + env vars

# Build & check
npm run build:react        # Production bundle → dist/
npm run typecheck          # tsc --noEmit
npm run lint               # ESLint
npm run lint:fix           # ESLint --fix
npm run format             # Prettier --write src/

# Testing
npm run test               # Vitest watch mode
npm run test:run           # Run once (CI)
npm run test:coverage      # Coverage report

# Deploy (ask user first)
vercel --prod              # ⚠️ Deploys to production
```

## Architecture

### Three-tier design

**Client (React SPA, `src/`)** — Vite bundles to `dist/`. Firebase JS SDK runs in the browser. State is split between Zustand (`src/store/useAppStore.ts`) for UI state and TanStack Query (`src/hooks/useWatchlist.ts`) for Firestore data. Auth flows through `AllowlistGate`, which checks the `allowedUsers/{email}` Firestore collection before granting access.

**API Gateway (`api/`)** — Vercel Serverless Functions (CommonJS, `api/package.json` sets `"type": "commonjs"`). These are the only code paths with Firebase Admin SDK credentials and external service calls (TMDB, OMDb, Resend, Axiom, Meta WhatsApp). Shared server utilities live in `src/api-lib/` (not bundled by Vite).

**Data Layer (Firestore)** — canonical title metadata lives in `titleRegistry/{registryId}` (written by API routes only). User watchlists reference registry IDs. Lists are either `users/{uid}/personalLists/{listId}` or `sharedLists/{listId}`.

### Key data flow

1. User clicks bookmarklet on IMDb → popup calls `POST /api/add-from-imdb`
2. API verifies Firebase ID token, calls TMDB/OMDb, writes to `titleRegistry`, appends registry ID to user's list
3. Client reads list items, hydrates with registry metadata, renders grid

### Vite proxy

In dev, `/api/*` requests from Vite (port 5173) proxy to `vercel dev` (port 3000). Configured in `vite.config.ts`.

### Two HTML entry points

- `index.html` → `src/main.tsx` (main SPA)
- `add.html` → `src/add-main.ts` (bookmarklet popup)

## Styling Rules

- Use design tokens from `styles.css` `:root` block — **never hardcode hex values or raw pixel sizes**
  - Colors: `--color-gold` (#E8C96A), `--color-red`, `--color-success`, `--color-surface-1/2/3`, `--color-text-muted`, etc.
  - Spacing: `--space-*` variables or multiples of 8px
  - Typography: `--text-*` variables
  - Border radius: `--radius-*` variables
- Buttons: extend `.btn-primary`, `.btn-secondary`, `.btn-ghost`, or `.btn-destructive`
- Dialogs: use existing `modal-header`, `modal-title` patterns
- Toasts: use `toast.error()` / `toast.success()` from `sonner` — never `window.alert()`

## Testing Rules

- Add Vitest tests for new pure utility functions in `src/lib/` and data transformation functions in `src/data/`
- When fixing a bug in an already-tested function, add a test case covering the bug
- Do **not** add tests for React components, API functions, or Firestore helpers — these are tested manually
- Run `npm run test:run` after changing tested files and confirm all tests pass

## Documentation Rules

After every feature change, new API route, new Firestore collection, or env var change, update **all** of:
- `README.md` (features, setup, env vars)
- `system-design.md` (services table, architecture, data model, API routes)
- For Firestore schema changes → update **system-design.md Section 3** in the same commit
- `docs/environment.md` and `.env.example` for env var changes
- If a new Firestore composite index is created: `firebase firestore:indexes > firestore.indexes.json`

Do not mark a task complete without updating docs.

## Project-Specific Gotchas

- **`src/api-lib/registry-id.cjs`** is a CommonJS copy of `src/lib/registry-id.ts` — if you change one, update the other
- **`api/` files are CommonJS** — no ES module syntax (`import`/`export`), use `require`/`module.exports`
- **`src/` files are ESM** — use `import`/`export`
- **Firestore quota guard** — every serverless function that reads Firestore must call `checkFirestoreQuota(db, estimatedReads)` from `src/api-lib/firestore-guard.js` before doing any reads
- **Admin UIDs** are hardcoded in `src/api-lib/admin-uids.js` and must stay in sync with `firestore.rules`
- **`AXIOM_TOKEN` / `AXIOM_DATASET`** should not be set locally — avoids polluting production observability data
- **`vercel dev`** loads all env vars from Vercel — do not use `.env` for server vars in development

## Firestore MCP

Firestore MCP is available for direct Firestore read/write access (useful for debugging). It **conflicts with `vercel dev` on port 3000** — stop `vercel dev` first, then restart Claude Code to use MCP.

## Key Files

| File | Purpose |
|------|---------|
| `src/firebase.ts` | Firebase JS SDK init + all client-side Firestore helpers (single entry point) |
| `src/store/useAppStore.ts` | Zustand state (filters, currentUser, modals) |
| `src/hooks/useWatchlist.ts` | TanStack Query hooks for Firestore reads |
| `src/hooks/useMutations.ts` | Firestore CRUD operations |
| `src/types/index.ts` | TypeScript type definitions |
| `src/api-lib/firestore-guard.js` | Quota enforcement before Firestore reads |
| `src/api-lib/registry-id.cjs` | CommonJS copy of `src/lib/registry-id.ts` for serverless functions |
| `src/api-lib/logger.js` | Axiom event logging for serverless functions |
| `src/lib/axiom-logger.ts` | Axiom event logging for client |
| `api/add-from-imdb.js` | Main bookmarklet endpoint (TMDB/OMDb enrichment + Firestore write) |
| `api/check-upcoming.js` | Cron job: syncs upcomingAlerts from TMDB (runs 03:00 UTC daily) |
| `api/external-status.js` | Admin: GitHub/Vercel/GCS/Axiom/Sentry status endpoints |
| `api/admin-job-config.js` | Admin: enable/disable scheduled jobs |
| `vercel.json` | Cron schedule, SPA rewrites, function timeouts |
| `firestore.rules` | Firestore security rules |
| `firestore.indexes.json` | Composite indexes (deploy with `firebase deploy --only firestore:indexes`) |
| `styles.css` | Design system tokens (`:root`) and base component classes |
| `system-design.md` | Full architecture, data model, API documentation |
| `.cursorrules` | Coding standards (source of truth — keep CLAUDE.md aligned) |
