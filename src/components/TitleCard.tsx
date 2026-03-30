import type { ReactElement } from "react";
import { renderServiceChips, servicesForMovie } from "../lib/movieDisplay.js";
import { sanitizePosterUrl } from "../lib/utils.js";
import { listKey } from "../firebase.js";
import { STATUS_ORDER, STATUS_LABELS } from "../store/useAppStore.js";
import type { StatusKey, WatchlistItem } from "../types/index.js";

export interface TitleCardProps {
  movie: WatchlistItem;
  /** When true, show who added the title (shared lists). */
  showAddedBy?: boolean;
  /** Current viewer — used for "Added by you" when `addedByUid` matches. */
  viewerUid?: string | null;
  /** Display name or email local part — legacy shared items when you are the list owner. */
  viewerDisplayName?: string | null;
  /** Firebase Auth profile image for the viewer (shared “added by you”). */
  viewerPhotoUrl?: string | null;
  /** `sharedLists/{id}.ownerId` — legacy rows without `addedBy*` infer owner vs member. */
  sharedListOwnerId?: string | null;
  /** `users/{sharedListOwnerId}.photoURL` for “added by list owner” when you are not the owner. */
  sharedListOwnerPhotoUrl?: string | null;
  userCountryCode: string;
  statusOpenKey: string | null;
  onSetStatusOpenKey: (key: string | null) => void;
  onStatusChange: (movie: WatchlistItem, status: StatusKey) => void;
  onOpenModal: (movie: WatchlistItem) => void;
  onRequestRemove: (movie: WatchlistItem) => void;
}

export function TitleCard({
  movie: m,
  showAddedBy = false,
  viewerUid = null,
  viewerDisplayName = null,
  viewerPhotoUrl = null,
  sharedListOwnerId = null,
  sharedListOwnerPhotoUrl = null,
  userCountryCode,
  statusOpenKey,
  onSetStatusOpenKey,
  onStatusChange,
  onOpenModal,
  onRequestRemove,
}: TitleCardProps) {
  const key = listKey(m);
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
  const langRaw = m.originalLanguage?.trim();
  const langCode =
    langRaw && langRaw.toLowerCase() !== "en" ? langRaw.slice(0, 2).toUpperCase() : null;
  const serviceChips = renderServiceChips(servicesForMovie(m, userCountryCode), { limit: 3 });
  const serviceRow = serviceChips ? (
    <div className="service-row" dangerouslySetInnerHTML={{ __html: serviceChips }} />
  ) : null;

  function sharedListAddedByLine(): string {
    const name = m.addedByDisplayName?.trim();
    if (name) return `Added by ${name}`;
    if (m.addedByUid) {
      if (viewerUid && m.addedByUid === viewerUid) return "Added by you";
      return "Added by another member";
    }
    // Legacy rows (no per-item attribution): infer from list owner.
    if (sharedListOwnerId && viewerUid && sharedListOwnerId === viewerUid) {
      const who = viewerDisplayName?.trim() || "you";
      return `Added by ${who}`;
    }
    if (sharedListOwnerId && viewerUid && sharedListOwnerId !== viewerUid) {
      return "Added by list owner";
    }
    return "Added by unknown";
  }

  const addedByAriaLabel = sharedListAddedByLine();

  function addedByAvatar(): { src: string; initial: string } | null {
    if (!showAddedBy) return null;
    if (m.addedByUid && viewerUid && m.addedByUid === viewerUid) {
      // Prefer Auth photo; fall back to merged `users/{uid}` (e.g. Auth missing photoURL in session).
      const src = sanitizePosterUrl(viewerPhotoUrl ?? m.addedByPhotoUrl ?? "");
      const label = viewerDisplayName?.trim() || m.addedByDisplayName?.trim() || "";
      return { src, initial: (label || "?").charAt(0).toUpperCase() };
    }
    if (m.addedByUid) {
      const src = sanitizePosterUrl(m.addedByPhotoUrl ?? "");
      return { src, initial: (m.addedByDisplayName || "?").charAt(0).toUpperCase() };
    }
    if (sharedListOwnerId && viewerUid && sharedListOwnerId === viewerUid) {
      const src = sanitizePosterUrl(viewerPhotoUrl ?? "");
      return { src, initial: (viewerDisplayName || "?").charAt(0).toUpperCase() };
    }
    if (sharedListOwnerId && viewerUid && sharedListOwnerId !== viewerUid) {
      const src = sanitizePosterUrl(sharedListOwnerPhotoUrl ?? "");
      return { src, initial: "O" };
    }
    return { src: "", initial: "?" };
  }

  const avatarBadge = showAddedBy ? addedByAvatar() : null;

  const s = m.status || "to-watch";
  const displayStatus = s;
  const statusTabKey = s === "watched" ? "watched" : s === "archive" ? "archive" : "to-watch";
  const statusIcons: Record<string, ReactElement> = {
    "to-watch": (
      <>
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" fill="none" />
        <circle cx="12" cy="12" r="3" fill="none" />
      </>
    ),
    watched: <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />,
    "maybe-later": (
      <>
        <circle cx="12" cy="12" r="9" fill="none" />
        <path d="M12 7v5l3 2" fill="none" />
      </>
    ),
    archive: (
      <>
        <polyline points="21 8 21 21 3 21 3 8" fill="none" />
        <rect x="1" y="3" width="22" height="5" fill="none" />
        <line x1="10" y1="12" x2="14" y2="12" />
      </>
    ),
  };
  const iconKey: keyof typeof statusIcons =
    displayStatus in statusIcons ? (displayStatus as keyof typeof statusIcons) : "to-watch";

  const useFill = displayStatus === "watched";

  return (
    <div
      className="card"
      data-watchlist-movie-key={key}
      role="button"
      tabIndex={0}
      aria-label={`Play trailer for ${m.title}`}
      onClick={(e) => {
        const t = e.target;
        if (
          t instanceof Element &&
          (t.closest(".status-badge-wrap") || t.closest(".card-delete-btn"))
        )
          return;
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
            {(["to-watch", "watched", "archive"] as StatusKey[]).map((st) => (
              <button
                key={st}
                type="button"
                className={`status-dropdown-item${st === statusTabKey ? " active" : ""}`}
                role="menuitem"
                data-status={st}
                onClick={(e) => {
                  e.stopPropagation();
                  const raw = m.status || "to-watch";
                  const current: StatusKey =
                    raw === "watched" ? "watched"
                    : raw === "archive" ? "archive"
                    : "to-watch";
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
          <span className="card-meta-main">
            <span className={`badge ${badgeClass}`}>{badgeLabel}</span>
            {langCode ? <span className="badge badge-lang">{langCode}</span> : null}
            {yearStr} &nbsp;·&nbsp; {m.genre}
          </span>
          {avatarBadge ? (
            <div
              className="card-added-by-avatar"
              role="img"
              aria-label={addedByAriaLabel}
              title={addedByAriaLabel}
            >
              {avatarBadge.src ? (
                <img
                  src={avatarBadge.src}
                  alt=""
                  className="card-added-by-avatar-img"
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  onError={(e) => {
                    e.currentTarget.style.display = "none";
                  }}
                />
              ) : null}
              <span className="card-added-by-avatar-initial">{avatarBadge.initial}</span>
            </div>
          ) : null}
        </div>
        {serviceRow}
      </div>
    </div>
  );
}
