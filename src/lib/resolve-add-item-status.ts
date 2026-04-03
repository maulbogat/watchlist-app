import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { listKey } from "../firebase.js";
import { listModeQueryKey } from "../hooks/useWatchlist.js";
import type { ListMode, StatusKey, WatchlistItem } from "../types/index.js";

function coerceStatus(s: string | undefined): StatusKey {
  if (s === "watched" || s === "to-watch") return s;
  return "to-watch";
}

/**
 * When adding a title to another list from the trailer modal, use the status from the list the user
 * is viewing (source list query cache), not a stale field on the modal payload.
 */
export function resolveStatusForCrossListAdd(
  item: WatchlistItem,
  uid: string,
  sourceListMode: ListMode,
  queryClient: QueryClient
): StatusKey {
  const modeKey = listModeQueryKey(sourceListMode);
  if (modeKey[0] === "none") return coerceStatus(item.status);
  const key: QueryKey = ["watchlistMovies", uid, ...modeKey];
  const movies = queryClient.getQueryData<WatchlistItem[]>(key);
  const k = listKey(item);
  const row = movies?.find((x) => listKey(x) === k);
  return coerceStatus(row?.status ?? item.status);
}
