/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FIREBASE_API_KEY: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN: string;
  readonly VITE_FIREBASE_PROJECT_ID: string;
  readonly VITE_FIREBASE_STORAGE_BUCKET: string;
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID: string;
  readonly VITE_FIREBASE_APP_ID: string;
  readonly VITE_FIREBASE_MEASUREMENT_ID: string;
  /** Production origin for Admin “Switch to prod” links (default in code: https://watchlist.maulbogat.com). */
  readonly VITE_APP_ORIGIN?: string;
  /** Admin “Deployments” card (e.g. https://vercel.com/your-team/your-project/deployments). */
  readonly VITE_DEPLOYMENTS_URL?: string;
  /** Sentry browser SDK DSN (client). Omit for a no-op. */
  readonly VITE_SENTRY_DSN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
