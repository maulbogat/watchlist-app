import {
  dismissUpcomingAlert,
  getStatusData as firebaseGetStatusData,
  getUserProfile as firebaseGetUserProfile,
  setUserCountry as firebaseSetUserCountry,
} from "../firebase.js";
import type { StatusData, UserProfile } from "../types/index.js";

export async function getUserProfile(uid: string): Promise<UserProfile> {
  return firebaseGetUserProfile(uid);
}

export async function setUserCountry(
  uid: string,
  countryCode: string,
  countryName: string | null | undefined
): Promise<void> {
  return firebaseSetUserCountry(uid, countryCode, countryName);
}

/** Record a single upcoming-alert dismissal on the user profile (fingerprint → YYYY-MM-DD). */
export async function updateDismissals(uid: string, fingerprint: string): Promise<void> {
  return dismissUpcomingAlert(uid, fingerprint);
}

export async function getDismissals(uid: string): Promise<Record<string, string>> {
  const data = await firebaseGetStatusData(uid);
  return data.upcomingDismissals ?? {};
}

/** Full default-list + profile slice used by onboarding and upcoming bar. */
export async function getStatusData(uid: string): Promise<StatusData> {
  return firebaseGetStatusData(uid);
}
