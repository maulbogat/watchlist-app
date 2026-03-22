import { auth, getStatusData, fetchUpcomingAlertsForItems, dismissUpcomingAlert } from "../../firebase.js";
import {
  movies,
  upcomingAlertsExpanded,
  setUpcomingAlertsExpanded,
  UPCOMING_CAL_ICON_SVG,
  UPCOMING_ADD_CAL_ICON_SVG,
} from "../store/state.js";
import {
  escapeHtml,
  formatUpcomingAirLabel,
  upcomingAlertHasRealAirDate,
  compactUpcomingDetail,
  getUpcomingAirDateYmd,
  buildUpcomingIcsDocument,
  safeIcsDownloadFilename,
  downloadUpcomingIcs,
} from "../lib/utils.js";

function renderUpcomingAlertPill(a) {
  const ymd = getUpcomingAirDateYmd(a);
  const dateLabel = formatUpcomingAirLabel(a);
  const fp = escapeHtml(String(a.fingerprint));
  const title = escapeHtml(String(a.title || ""));
  const detailCompact = escapeHtml(compactUpcomingDetail(a.detail));
  const dateBlock = `<span class="upcoming-alert-date-block">${UPCOMING_CAL_ICON_SVG}<span class="upcoming-alert-date-text">${escapeHtml(dateLabel)}</span></span>`;
  const calCol = ymd
    ? `<div class="upcoming-alert-cal-add-col">
      <button type="button" class="upcoming-alert-add-cal-btn" aria-label="Add to calendar" title="Download calendar file (.ics) for Apple Calendar, Google Calendar, Outlook…"
        data-cal-date="${escapeHtml(ymd)}"
        data-cal-title="${encodeURIComponent(String(a.title || ""))}"
        data-cal-detail="${encodeURIComponent(String(a.detail || ""))}">
        ${UPCOMING_ADD_CAL_ICON_SVG}
      </button>
    </div>`
    : "";
  return `<div class="upcoming-alert-pill upcoming-alert-pill--confirmed" data-fp="${fp}" role="status">
    <div class="upcoming-alert-pill-body">
      <div class="upcoming-alert-title">${title}</div>
      <div class="upcoming-alert-second-row">
        <span class="upcoming-alert-detail-compact">${detailCompact}</span>
        ${dateBlock}
      </div>
    </div>
    ${calCol}
    <div class="upcoming-alert-dismiss-col">
      <button type="button" class="upcoming-alert-dismiss" aria-label="Dismiss upcoming alert">×</button>
    </div>
  </div>`;
}

export function clearUpcomingAlertsBar() {
  setUpcomingAlertsExpanded(false);
  const mount = document.getElementById("upcoming-alerts-mount");
  if (mount) {
    mount.hidden = true;
    mount.innerHTML = "";
    mount.classList.remove("upcoming-alerts-mount--visible", "upcoming-alerts-mount--hiding");
    mount.removeAttribute("data-expanded");
  }
}

/** Fade/slide the whole bar away, then clear DOM (dismiss-all / list has no alerts). */
function hideUpcomingBarWithAnimation(mount) {
  const panel = mount.querySelector(".upcoming-alerts-panel");
  const done = () => {
    setUpcomingAlertsExpanded(false);
    mount.hidden = true;
    mount.innerHTML = "";
    mount.classList.remove("upcoming-alerts-mount--visible", "upcoming-alerts-mount--hiding");
    mount.removeAttribute("data-expanded");
  };
  if (!panel) {
    done();
    return;
  }
  requestAnimationFrame(() => {
    mount.classList.add("upcoming-alerts-mount--hiding");
  });
  const fallback = setTimeout(done, 500);
  panel.addEventListener(
    "transitionend",
    (e) => {
      if (e.target !== panel || (e.propertyName !== "opacity" && e.propertyName !== "transform")) return;
      clearTimeout(fallback);
      done();
    },
    { once: true }
  );
}

export async function refreshUpcomingAlertsBar(user) {
  const mount = document.getElementById("upcoming-alerts-mount");
  if (!mount) return;
  const u = user || auth.currentUser;
  if (!u) {
    clearUpcomingAlertsBar();
    return;
  }
  try {
    const data = await getStatusData(u.uid);
    const dismissals = data.upcomingDismissals || {};
    const raw = await fetchUpcomingAlertsForItems(movies);
    const active = raw.filter(
      (a) => a.fingerprint && !dismissals[a.fingerprint] && upcomingAlertHasRealAirDate(a)
    );
    active.sort((a, b) => {
      const ad = getUpcomingAirDateYmd(a) || "9999-12-31";
      const bd = getUpcomingAirDateYmd(b) || "9999-12-31";
      if (ad !== bd) return ad.localeCompare(bd);
      return String(a.title || "").localeCompare(String(b.title || ""));
    });
    if (active.length === 0) {
      if (mount.classList.contains("upcoming-alerts-mount--visible") && mount.querySelector(".upcoming-alert-pill")) {
        hideUpcomingBarWithAnimation(mount);
        return;
      }
      clearUpcomingAlertsBar();
      return;
    }
    const wasBarHidden = mount.hidden || !mount.classList.contains("upcoming-alerts-mount--visible");
    mount.hidden = false;
    mount.classList.remove("upcoming-alerts-mount--hiding");
    mount.classList.add("upcoming-alerts-mount--visible");
    mount.dataset.expanded = upcomingAlertsExpanded ? "true" : "false";
    const maxInitial = 3;
    const restCount = Math.max(0, active.length - maxInitial);
    const allPillsHtml = active.map((a) => renderUpcomingAlertPill(a)).join("");
    const firstOnlyHtml = active.slice(0, maxInitial).map((a) => renderUpcomingAlertPill(a)).join("");
    const extraOnlyHtml = active.slice(maxInitial).map((a) => renderUpcomingAlertPill(a)).join("");

    let pillsRowHtml = "";
    let lessRowHtml = "";

    if (upcomingAlertsExpanded && restCount > 0) {
      /* One continuous flex-wrap row — same wrapping rules for every pill, no divider block */
      pillsRowHtml = allPillsHtml;
      lessRowHtml = `<div class="upcoming-alerts-toggle-row"><button type="button" class="upcoming-alerts-less-btn">Show less ↑</button></div>`;
    } else if (restCount > 0) {
      const moreBtnHtml = `<button type="button" class="upcoming-alert-pill upcoming-alerts-more-btn"><span class="upcoming-alerts-more-btn-label">and ${restCount} more →</span></button>`;
      pillsRowHtml = `${firstOnlyHtml}${moreBtnHtml}<div class="upcoming-alerts-extras">${extraOnlyHtml}</div>`;
    } else {
      pillsRowHtml = allPillsHtml;
    }

    mount.innerHTML = `<div class="upcoming-alerts-panel">
      <div class="upcoming-alerts-inner">
        <div class="upcoming-alerts-pills">
          ${pillsRowHtml}
        </div>
        ${lessRowHtml}
      </div>
    </div>`;
    const panel = mount.querySelector(".upcoming-alerts-panel");
    if (panel && wasBarHidden) {
      panel.classList.add("upcoming-alerts-panel--animate-in");
      panel.addEventListener(
        "animationend",
        () => panel.classList.remove("upcoming-alerts-panel--animate-in"),
        { once: true }
      );
    }
    mount.querySelectorAll(".upcoming-alert-add-cal-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        const pillEl = btn.closest(".upcoming-alert-pill");
        const fp = pillEl?.dataset.fp || "upcoming";
        const ymd = btn.dataset.calDate;
        let title = "";
        let detail = "";
        try {
          title = decodeURIComponent(btn.dataset.calTitle || "");
        } catch {
          title = "";
        }
        try {
          detail = decodeURIComponent(btn.dataset.calDetail || "");
        } catch {
          detail = "";
        }
        const doc = buildUpcomingIcsDocument({ ymd, title, detail, uid: fp });
        if (!doc) return;
        downloadUpcomingIcs(doc, safeIcsDownloadFilename(title));
      });
    });
    mount.querySelectorAll(".upcoming-alert-dismiss").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const pillEl = btn.closest(".upcoming-alert-pill");
        const fp = pillEl?.dataset.fp;
        if (!fp || !auth.currentUser) return;
        pillEl.classList.add("upcoming-alert-pill--out");
        let doneRemove = false;
        const removePill = () => {
          if (doneRemove) return;
          doneRemove = true;
          pillEl.remove();
          const pillsRoot = mount.querySelector(".upcoming-alerts-pills");
          if (pillsRoot && !pillsRoot.querySelector(".upcoming-alert-pill")) {
            hideUpcomingBarWithAnimation(mount);
          }
        };
        pillEl.addEventListener("transitionend", (ev) => {
          if (ev.propertyName === "opacity") removePill();
        });
        try {
          await dismissUpcomingAlert(auth.currentUser.uid, fp);
        } catch (err) {
          console.warn("dismiss upcoming:", err);
        }
        setTimeout(removePill, 480);
      });
    });
    const moreBtn = mount.querySelector(".upcoming-alerts-more-btn");
    if (moreBtn) {
      moreBtn.addEventListener("click", () => {
        setUpcomingAlertsExpanded(true);
        refreshUpcomingAlertsBar(auth.currentUser);
      });
    }
    const lessBtn = mount.querySelector(".upcoming-alerts-less-btn");
    if (lessBtn) {
      lessBtn.addEventListener("click", () => {
        setUpcomingAlertsExpanded(false);
        refreshUpcomingAlertsBar(auth.currentUser);
      });
    }
  } catch (e) {
    console.warn("upcoming alerts:", e);
    mount.hidden = true;
  }
}

export async function afterMoviesReloaded(user) {
  const u = user || auth.currentUser;
  if (!u) return;
  await refreshUpcomingAlertsBar(u);
}
