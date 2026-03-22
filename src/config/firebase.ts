/**
 * Firebase Web SDK configuration (public — shipped to the browser).
 */
import type { FirebaseOptions } from "firebase/app";

const required = [
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_APP_ID",
] as const;

for (const key of required) {
  if (!import.meta.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

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

function resolveAuthDomain(rawAuthDomain: unknown, rawProjectId: unknown): string {
  const projectId = cleanEnv(rawProjectId);
  const authDomain = normalizeAuthDomain(rawAuthDomain);
  const fallback = projectId ? `${projectId}.firebaseapp.com` : authDomain;
  // Guard against masked/invalid values (e.g. ********.com) making Firebase iframe URL illegal.
  if (!authDomain || authDomain.includes("*") || !/^[a-z0-9.-]+$/i.test(authDomain)) return fallback;
  return authDomain;
}

const projectId = cleanEnv(import.meta.env.VITE_FIREBASE_PROJECT_ID);

export const firebaseConfig: FirebaseOptions = {
  apiKey: cleanEnv(import.meta.env.VITE_FIREBASE_API_KEY),
  authDomain: resolveAuthDomain(import.meta.env.VITE_FIREBASE_AUTH_DOMAIN, projectId),
  projectId,
  storageBucket: cleanEnv(import.meta.env.VITE_FIREBASE_STORAGE_BUCKET),
  messagingSenderId: cleanEnv(import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID),
  appId: cleanEnv(import.meta.env.VITE_FIREBASE_APP_ID),
  measurementId: cleanEnv(import.meta.env.VITE_FIREBASE_MEASUREMENT_ID),
};
