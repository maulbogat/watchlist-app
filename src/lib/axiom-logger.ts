import { getApp, getApps, initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";

import { firebaseConfig } from "../config/firebase.js";

type LogValue = string | number | boolean | null | undefined;
type LogEventPayload = {
  type: string;
  uid?: string | null;
} & Record<string, LogValue>;

const appVersion = (import.meta.env.VITE_APP_VERSION as string | undefined) || "1.0.0";
const environment = import.meta.env.MODE || "unknown";

/** Same-origin Netlify function — token stays on the server (`AXIOM_*`), not in `dist/` bundles. */
const LOG_CLIENT_EVENT_PATH = "/api/log-client-event";

function getFirebaseApp() {
  return getApps().length ? getApp() : initializeApp(firebaseConfig);
}

async function getClientIdToken(): Promise<string | null> {
  try {
    const auth = getAuth(getFirebaseApp());
    const user = auth.currentUser;
    if (!user) return null;
    return await user.getIdToken();
  } catch {
    return null;
  }
}

export async function logEvent(payload: LogEventPayload): Promise<void> {
  try {
    const { type, ...rest } = payload;
    const event = {
      timestamp: new Date().toISOString(),
      environment,
      appVersion,
      type: type || "unknown",
      ...rest,
    };

    const idToken = await getClientIdToken();
    if (!idToken) {
      return;
    }

    await fetch(LOG_CLIENT_EVENT_PATH, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify(event),
    });
  } catch {
    // logging must never break flow
  }
}
