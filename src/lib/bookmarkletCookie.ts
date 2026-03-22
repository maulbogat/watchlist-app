import type { User } from "firebase/auth";
import { getBookmarkletPersonalListFirestoreId } from "../firebase.js";
import type { ListMode } from "../types/index.js";

/**
 * Sync bookmarklet cookies for HTTPS using the current list mode from callers (e.g. Zustand).
 */
export async function setBookmarkletCookieWithMode(
  user: Pick<User, "uid" | "getIdToken"> | null,
  currentListMode: ListMode
): Promise<void> {
  if (window.location.protocol !== "https:") return;
  try {
    if (!user) {
      document.cookie = "bookmarklet_token=; path=/; max-age=0";
      document.cookie = "bookmarklet_list_id=; path=/; max-age=0";
      document.cookie = "bookmarklet_personal_list_id=; path=/; max-age=0";
      return;
    }
    const token = await user.getIdToken();
    document.cookie = `bookmarklet_token=${token}; path=/; max-age=2592000; SameSite=None; Secure`;
    if (typeof currentListMode === "object" && currentListMode.type === "shared") {
      document.cookie = `bookmarklet_list_id=${encodeURIComponent(currentListMode.listId)}; path=/; max-age=2592000; SameSite=None; Secure`;
      document.cookie = "bookmarklet_personal_list_id=; path=/; max-age=0";
    } else {
      document.cookie = "bookmarklet_list_id=; path=/; max-age=0";
      const listId =
        currentListMode === "personal"
          ? "personal"
          : typeof currentListMode === "object" && currentListMode.type === "personal"
            ? currentListMode.listId
            : "personal";
      const pid = await getBookmarkletPersonalListFirestoreId(user.uid, listId);
      if (pid) {
        document.cookie = `bookmarklet_personal_list_id=${encodeURIComponent(pid)}; path=/; max-age=2592000; SameSite=None; Secure`;
      } else {
        document.cookie = "bookmarklet_personal_list_id=; path=/; max-age=0";
      }
    }
  } catch (e) {
    console.warn("Bookmarklet cookie:", e);
  }
}
