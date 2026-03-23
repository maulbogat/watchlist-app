import { useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { UpcomingAlert, WatchlistItem } from "../types/index.js";
import { auth, fetchUpcomingAlertsForItems, movieKey } from "../firebase.js";
import { getStatusData, updateDismissals } from "../data/user.js";
import { clearUpcomingAlertsCache, readUpcomingAlertsCache, writeUpcomingAlertsCache } from "../lib/storage.js";
import { useAppStore, UPCOMING_ADD_CAL_ICON_SVG, UPCOMING_CAL_ICON_SVG } from "../store/useAppStore.js";
import {
  buildUpcomingIcsDocument,
  compactUpcomingDetail,
  downloadUpcomingIcs,
  escapeHtml,
  formatUpcomingAirLabel,
  getUpcomingAirDateYmd,
  safeIcsDownloadFilename,
  upcomingAlertHasRealAirDate,
} from "../lib/utils.js";

type UpcomingBarData = { active: UpcomingAlert[] };

function useUpcomingAlertsQuery(uid: string | undefined, movies: WatchlistItem[] | undefined) {
  const ids = useMemo(() => {
    const keys = (movies || []).map((m) => movieKey(m)).filter(Boolean);
    keys.sort();
    return keys.join(",");
  }, [movies]);

  return useQuery<UpcomingBarData>({
    queryKey: ["upcomingBar", uid, ids],
    queryFn: async () => {
      if (!uid) return { active: [] };
      const data = await getStatusData(uid);
      const dismissals = data.upcomingDismissals || {};
      const cached = readUpcomingAlertsCache(uid, ids);
      const raw = cached ?? (await fetchUpcomingAlertsForItems(movies || []));
      if (!cached) writeUpcomingAlertsCache(uid, ids, raw);
      const active = raw.filter(
        (a) => a.fingerprint && !dismissals[a.fingerprint] && upcomingAlertHasRealAirDate(a)
      );
      active.sort((a, b) => {
        const ad = getUpcomingAirDateYmd(a) || "9999-12-31";
        const bd = getUpcomingAirDateYmd(b) || "9999-12-31";
        if (ad !== bd) return ad.localeCompare(bd);
        return String(a.title || "").localeCompare(String(b.title || ""));
      });
      return { active };
    },
    enabled: !!uid,
    staleTime: 2 * 60 * 60 * 1000,
  });
}

interface UpcomingPillProps {
  a: UpcomingAlert;
  userUid: string;
}

function UpcomingPill({ a, userUid }: UpcomingPillProps) {
  const queryClient = useQueryClient();
  const ymd = getUpcomingAirDateYmd(a);
  const dateLabel = formatUpcomingAirLabel(a);
  const fp = String(a.fingerprint);
  const title = String(a.title || "");
  const detailCompact = compactUpcomingDetail(a.detail);
  const [out, setOut] = useState(false);

  return (
    <div
      className={`upcoming-alert-pill upcoming-alert-pill--confirmed${out ? " upcoming-alert-pill--out" : ""}`}
      data-fp={fp}
      role="status"
    >
      <div className="upcoming-alert-pill-body">
        <div className="upcoming-alert-title">{title}</div>
        <div className="upcoming-alert-second-row">
          <span className="upcoming-alert-detail-compact">{detailCompact}</span>
          <span
            className="upcoming-alert-date-block"
            dangerouslySetInnerHTML={{
              __html: `${UPCOMING_CAL_ICON_SVG}<span class="upcoming-alert-date-text">${escapeHtml(dateLabel)}</span>`,
            }}
          />
        </div>
      </div>
      {ymd ? (
        <div className="upcoming-alert-cal-add-col">
          <button
            type="button"
            className="upcoming-alert-add-cal-btn"
            aria-label="Add to calendar"
            title="Download calendar file (.ics) for Apple Calendar, Google Calendar, Outlook…"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              const doc = buildUpcomingIcsDocument({
                ymd,
                title,
                detail: String(a.detail || ""),
                uid: fp,
              });
              if (!doc) return;
              downloadUpcomingIcs(doc, safeIcsDownloadFilename(title));
            }}
            dangerouslySetInnerHTML={{ __html: UPCOMING_ADD_CAL_ICON_SVG }}
          />
        </div>
      ) : null}
      <div className="upcoming-alert-dismiss-col">
        <button
          type="button"
          className="upcoming-alert-dismiss"
          aria-label="Dismiss upcoming alert"
          onClick={async (e) => {
            e.stopPropagation();
            setOut(true);
            try {
              const dismissUid = auth.currentUser?.uid;
              if (dismissUid) await updateDismissals(dismissUid, fp);
              clearUpcomingAlertsCache(dismissUid || undefined);
            } catch (err) {
              console.warn("dismiss upcoming:", err);
            }
            window.setTimeout(() => {
              queryClient.invalidateQueries({ queryKey: ["upcomingBar", userUid] });
            }, 480);
          }}
        >
          ×
        </button>
      </div>
    </div>
  );
}

interface UpcomingAlertsBarProps {
  movies: WatchlistItem[];
}

export function UpcomingAlertsBar({ movies }: UpcomingAlertsBarProps) {
  const currentUser = useAppStore((s) => s.currentUser);
  const expanded = useAppStore((s) => s.upcomingAlertsExpanded);
  const setExpanded = useAppStore((s) => s.setUpcomingAlertsExpanded);
  const { data, isSuccess } = useUpcomingAlertsQuery(currentUser?.uid, movies);

  if (!currentUser?.uid || !isSuccess) return null;

  const active = data?.active ?? [];
  if (active.length === 0) return null;

  const maxInitial = 3;
  const restCount = Math.max(0, active.length - maxInitial);
  const firstSlice = active.slice(0, maxInitial);
  const extraSlice = active.slice(maxInitial);

  let pillsRow: ReactNode;
  let lessRow: ReactNode = null;

  if (expanded && restCount > 0) {
    pillsRow = active.map((a) => <UpcomingPill key={a.fingerprint} a={a} userUid={currentUser.uid} />);
    lessRow = (
      <div className="upcoming-alerts-toggle-row">
        <button type="button" className="upcoming-alerts-less-btn" onClick={() => setExpanded(false)}>
          Show less ↑
        </button>
      </div>
    );
  } else if (restCount > 0) {
    pillsRow = (
      <>
        {firstSlice.map((a) => (
          <UpcomingPill key={a.fingerprint} a={a} userUid={currentUser.uid} />
        ))}
        <button
          type="button"
          className="upcoming-alert-pill upcoming-alerts-more-btn"
          onClick={() => setExpanded(true)}
        >
          <span className="upcoming-alerts-more-btn-label">and {restCount} more →</span>
        </button>
        <div className="upcoming-alerts-extras">
          {extraSlice.map((a) => (
            <UpcomingPill key={a.fingerprint} a={a} userUid={currentUser.uid} />
          ))}
        </div>
      </>
    );
  } else {
    pillsRow = active.map((a) => <UpcomingPill key={a.fingerprint} a={a} userUid={currentUser.uid} />);
  }

  return (
    <div
      id="upcoming-alerts-mount"
      className="upcoming-alerts-mount upcoming-alerts-mount--visible"
      data-expanded={expanded ? "true" : "false"}
    >
      <div className="upcoming-alerts-panel">
        <div className="upcoming-alerts-inner">
          <div className="upcoming-alerts-pills">{pillsRow}</div>
          {lessRow}
        </div>
      </div>
    </div>
  );
}
