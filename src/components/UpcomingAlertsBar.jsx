import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  auth,
  dismissUpcomingAlert,
  fetchUpcomingAlertsForItems,
  getStatusData,
  movieKey,
} from "../../firebase.js";
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

function useUpcomingAlertsQuery(user, movies) {
  const ids = useMemo(() => {
    const keys = (movies || []).map((m) => movieKey(m)).filter(Boolean);
    keys.sort();
    return keys.join(",");
  }, [movies]);

  return useQuery({
    queryKey: ["upcomingBar", user?.uid, ids],
    queryFn: async () => {
      const data = await getStatusData(user.uid);
      const dismissals = data.upcomingDismissals || {};
      const raw = await fetchUpcomingAlertsForItems(movies || []);
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
    enabled: !!user?.uid,
    staleTime: 30_000,
  });
}

/**
 * @param {{ a: object, userUid: string }} props
 */
function UpcomingPill({ a, userUid }) {
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
              await dismissUpcomingAlert(auth.currentUser?.uid, fp);
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

/**
 * @param {{ user: { uid: string }, movies: any[] }} props
 */
export function UpcomingAlertsBar({ user, movies }) {
  const expanded = useAppStore((s) => s.upcomingAlertsExpanded);
  const setExpanded = useAppStore((s) => s.setUpcomingAlertsExpanded);
  const { data, isSuccess } = useUpcomingAlertsQuery(user, movies);

  if (!user?.uid || !isSuccess) return null;

  const active = data?.active ?? [];
  if (active.length === 0) return null;

  const maxInitial = 3;
  const restCount = Math.max(0, active.length - maxInitial);
  const firstSlice = active.slice(0, maxInitial);
  const extraSlice = active.slice(maxInitial);

  let pillsRow;
  let lessRow = null;

  if (expanded && restCount > 0) {
    pillsRow = active.map((a) => <UpcomingPill key={a.fingerprint} a={a} userUid={user.uid} />);
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
          <UpcomingPill key={a.fingerprint} a={a} userUid={user.uid} />
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
            <UpcomingPill key={a.fingerprint} a={a} userUid={user.uid} />
          ))}
        </div>
      </>
    );
  } else {
    pillsRow = active.map((a) => <UpcomingPill key={a.fingerprint} a={a} userUid={user.uid} />);
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
