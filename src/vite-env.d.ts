/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FIREBASE_API_KEY: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN: string;
  readonly VITE_FIREBASE_PROJECT_ID: string;
  readonly VITE_FIREBASE_STORAGE_BUCKET: string;
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID: string;
  readonly VITE_FIREBASE_APP_ID: string;
  readonly VITE_FIREBASE_MEASUREMENT_ID: string;
  /** Production origin for Admin links / bookmarklet (default in code: watchlist-trailers.vercel.app). */
  readonly VITE_APP_ORIGIN?: string;
  /** Admin “Deployments” card (e.g. https://vercel.com/your-team/your-project/deployments). */
  readonly VITE_DEPLOYMENTS_URL?: string;
  /** Optional id for `admin-env-status` SITE_ID flag (Vercel project id or any marker). */
  readonly VITE_SITE_ID?: string;
  /** Legacy Netlify deploy badge only. */
  readonly VITE_NETLIFY_SITE_ID?: string;
  readonly VITE_NETLIFY_PROJECT_SLUG?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
