/**
 * Firebase Web SDK configuration (public — shipped to the browser).
 */
import type { FirebaseOptions } from "firebase/app";

const DEFAULT_FIREBASE_WEB_CONFIG = {
  apiKey: "AIzaSyDKnQufhinuv-jKXNOyVM_mQDmRpdOD0VA",
  authDomain: "movie-trailer-site.firebaseapp.com",
  projectId: "movie-trailer-site",
  storageBucket: "movie-trailer-site.firebasestorage.app",
  messagingSenderId: "760692399711",
  appId: "1:760692399711:web:322f98f5fe127aa5f2c5ea",
  measurementId: "G-4799K3WXK4",
} as const;

function cleanEnv(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function normalizeAuthDomain(value: unknown): string {
  let v = cleanEnv(value);
  if (!v) return "";
  try {
    v = decodeURIComponent(v);
  } catch {
    // Keep raw value if not URL-encoded.
  }
  v = v.replace(/^https?:\/\//i, "");
  v = v.replace(/\/+$/, "");
  if (v.includes("/")) v = v.split("/")[0] ?? v;
  return v;
}

function isMaskedOrInvalid(value: string): boolean {
  return !value || value.includes("*");
}

function resolveString(raw: unknown, fallback: string): string {
  const v = cleanEnv(raw);
  return isMaskedOrInvalid(v) ? fallback : v;
}

function resolveAuthDomain(rawAuthDomain: unknown, rawProjectId: unknown): string {
  const projectId = resolveString(rawProjectId, DEFAULT_FIREBASE_WEB_CONFIG.projectId);
  const authDomain = normalizeAuthDomain(rawAuthDomain);
  const safeProjectId =
    projectId && !projectId.includes("*") && /^[a-z0-9-]+$/i.test(projectId)
      ? projectId
      : DEFAULT_FIREBASE_WEB_CONFIG.projectId;
  const fallback = `${safeProjectId}.firebaseapp.com`;
  // Prefer deterministic project-based authDomain in production to avoid bad env values.
  if (import.meta.env.PROD) return fallback;
  // Guard against masked/invalid values (e.g. ********.com) making Firebase iframe URL illegal.
  if (!authDomain || authDomain.includes("*") || !/^[a-z0-9.-]+$/i.test(authDomain))
    return fallback;
  return authDomain;
}

const projectId = resolveString(
  import.meta.env.VITE_FIREBASE_PROJECT_ID,
  DEFAULT_FIREBASE_WEB_CONFIG.projectId
);

export const firebaseConfig: FirebaseOptions = {
  apiKey: resolveString(import.meta.env.VITE_FIREBASE_API_KEY, DEFAULT_FIREBASE_WEB_CONFIG.apiKey),
  authDomain: resolveAuthDomain(import.meta.env.VITE_FIREBASE_AUTH_DOMAIN, projectId),
  projectId,
  storageBucket: resolveString(
    import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    DEFAULT_FIREBASE_WEB_CONFIG.storageBucket
  ),
  messagingSenderId: resolveString(
    import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    DEFAULT_FIREBASE_WEB_CONFIG.messagingSenderId
  ),
  appId: resolveString(import.meta.env.VITE_FIREBASE_APP_ID, DEFAULT_FIREBASE_WEB_CONFIG.appId),
  measurementId: resolveString(
    import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
    DEFAULT_FIREBASE_WEB_CONFIG.measurementId
  ),
};
