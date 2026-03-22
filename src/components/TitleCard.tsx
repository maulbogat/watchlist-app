import type { ReactElement } from "react";
import { renderServiceChips, servicesForMovie } from "../lib/movieDisplay.js";
import { sanitizePosterUrl } from "../lib/utils.js";
import { movieKey } from "../firebase.js";
import { STATUS_ORDER, STATUS_LABELS } from "../store/useAppStore.js";
import type { StatusKey, WatchlistItem } from "../types/index.js";

export interface TitleCardProps {
  movie: WatchlistItem;
  userCountryCode: string;
  statusOpenKey: string | null;
  onSetStatusOpenKey: (key: string | null) => void;
  onStatusChange: (movie: WatchlistItem, status: StatusKey) => void;
  onOpenModal: (movie: WatchlistItem) => void;
  onRequestRemove: (movie: WatchlistItem) => void;
}

export function TitleCard({
  movie: m,
  userCountryCode,
  statusOpenKey,
  onSetStatusOpenKey,
  onStatusChange,
  onOpenModal,
  onRequestRemove,
}: TitleCardProps) {
  const key = movieKey(m);
  const menuOpen = statusOpenKey === key;
  const thumbSrc = sanitizePosterUrl(m.thumb);
  const thumbHTML = thumbSrc ? (
    <>
      <img
        src={thumbSrc}
        alt={`${m.title} trailer thumbnail`}
        loading="lazy"
        onError={(e) => {
          e.currentTarget.style.display = "none";
          const ph = e.currentTarget.nextElementSibling;
          if (ph instanceof HTMLElement) ph.style.display = "flex";
        }}
      />
      <div className="thumb-placeholder" style={{ display: "none" }}>
        {m.title}
      </div>
    </>
  ) : (
    <div className="thumb-placeholder">{m.title}</div>
  );

  const yearStr = m.year ? m.year : "—";
  const badgeClass = m.type === "show" ? "badge-show" : "badge-movie";
  const badgeLabel = m.type === "show" ? "TV" : "Film";
  const serviceChips = renderServiceChips(servicesForMovie(m, userCountryCode), { limit: 3 });
  const serviceRow = serviceChips ? <div className="service-row" dangerouslySetInnerHTML={{ __html: serviceChips }} /> : null;

  const s = m.status || "to-watch";
  const displayStatus = s;
  const statusTabKey =
    s === "watched" ? "watched" : s === "archive" ? "archive" : "to-watch";
  const statusIcons: Record<string, ReactElement> = {
    "to-watch": (
      <>
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" fill="none" />
        <circle cx="12" cy="12" r="3" fill="none" />
      </>
    ),
    watched: <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />,
    archive: (
      <path d="M4 7h16M6 7V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2M4 7v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7M9 12h6" fill="none" />
    ),
    "maybe-later": (
      <>
        <circle cx="12" cy="12" r="9" fill="none" />
        <path d="M12 7v5l3 2" fill="none" />
      </>
    ),
  };
  const iconKey: keyof typeof statusIcons = displayStatus in statusIcons ? (displayStatus as keyof typeof statusIcons) : "to-watch";

  const useFill = displayStatus === "watched";

  return (
    <div
      className="card"
      role="button"
      tabIndex={0}
      aria-label={`Play trailer for ${m.title}`}
      onClick={(e) => {
        const t = e.target;
        if (t instanceof Element && (t.closest(".status-badge-wrap") || t.closest(".card-delete-btn"))) return;
        onOpenModal(m);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onOpenModal(m);
      }}
    >
      <div className="thumb-wrap">
        <button
          type="button"
          className="card-delete-btn"
          aria-label="Remove from list"
          title="Remove"
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onRequestRemove(m);
          }}
        >
          &#215;
        </button>
        <div className="status-badge-wrap">
          <button
            type="button"
            className={`status-badge status-${displayStatus}`}
            aria-label="Change status"
            title="Change status"
            data-status={displayStatus}
            aria-haspopup="true"
            aria-expanded={menuOpen}
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              onSetStatusOpenKey(menuOpen ? null : key);
            }}
          >
            <svg
              viewBox="0 0 24 24"
              fill={useFill ? "currentColor" : "none"}
              stroke="currentColor"
              strokeWidth="2"
            >
              {statusIcons[iconKey]}
            </svg>
          </button>
          <div
            className={`status-dropdown${menuOpen ? " open" : ""}`}
            role="menu"
            aria-label="Move to"
          >
            {STATUS_ORDER.map((st) => (
              <button
                key={st}
                type="button"
                className={`status-dropdown-item${st === statusTabKey ? " active" : ""}`}
                role="menuitem"
                data-status={st}
                onClick={(e) => {
                  e.stopPropagation();
                  const raw = m.status || "to-watch";
                  const current =
                    raw === "watched" ? "watched" : raw === "archive" ? "archive" : "to-watch";
                  if (st !== current) onStatusChange(m, st);
                  onSetStatusOpenKey(null);
                }}
              >
                {STATUS_LABELS[st]}
              </button>
            ))}
          </div>
        </div>
        {thumbHTML}
        <div className="thumb-overlay" />
        <div className="play-btn">
          <svg viewBox="0 0 24 24">
            <path d="M8 5v14l11-7z" />
          </svg>
        </div>
      </div>
      <div className="card-info">
        <div className="card-title" dir={/[\u0590-\u05FF]/.test(m.title) ? "rtl" : undefined}>
          {m.title}
        </div>
        <div className="card-meta">
          <span className={`badge ${badgeClass}`}>{badgeLabel}</span>
          {yearStr} &nbsp;·&nbsp; {m.genre}
        </div>
        {serviceRow}
      </div>
    </div>
  );
}
