import type { UpcomingAlert } from "../types/index.js";

/** Safe string for user-facing error alerts from unknown catch values. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "Unknown error";
}

/**
 * Poster/thumb URLs (e.g. m.media-amazon.com) must not contain stray whitespace —
 * a line break or space in the middle yields 404s.
 */
export function sanitizePosterUrl(url: unknown): string {
  if (url == null) return "";
  const s = String(url).trim();
  return s.replace(/\s+/g, "");
}

/** Shown in UI when Firestore has no persisted name yet (legacy). Not a stored default. */
export function displayListName(name: unknown): string {
  const n = String(name ?? "").trim();
  return n || "Set name…";
}

export function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

/** Normalize Firestore string / Timestamp-shaped values to a YYYY-MM-DD or ISO-ish string for display/rules. */
export function getUpcomingAirDateString(alert: UpcomingAlert | Record<string, unknown> | null | undefined): string {
  const d = alert && typeof alert === "object" && "airDate" in alert ? (alert as { airDate?: unknown }).airDate : undefined;
  if (d == null) return "";
  if (typeof d === "string") return d.trim();
  if (typeof d === "object" && d !== null && "toDate" in d && typeof (d as { toDate: () => Date }).toDate === "function") {
    try {
      const dt = (d as { toDate: () => Date }).toDate();
      return Number.isNaN(dt.getTime()) ? "" : dt.toISOString().slice(0, 10);
    } catch {
      return "";
    }
  }
  if (typeof d === "object" && d !== null && "seconds" in d) {
    const sec = (d as { seconds: number }).seconds;
    const dt = new Date(sec * 1000);
    return Number.isNaN(dt.getTime()) ? "" : dt.toISOString().slice(0, 10);
  }
  const s = String(d).trim();
  return s && s !== "[object Object]" ? s : "";
}

export function formatUpcomingAirLabel(alert: UpcomingAlert | Record<string, unknown>): string {
  const raw = getUpcomingAirDateString(alert);
  if (!raw) return "TBA";
  try {
    const d = new Date(raw.includes("T") ? raw : `${raw}T12:00:00`);
    if (Number.isNaN(d.getTime())) return raw;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return raw;
  }
}

export function upcomingAlertHasRealAirDate(alert: UpcomingAlert | Record<string, unknown>): boolean {
  const s = getUpcomingAirDateString(alert);
  if (!s || s.toUpperCase() === "TBA") return false;
  const raw = s.includes("T") ? s : `${s}T12:00:00`;
  const dt = new Date(raw);
  return !Number.isNaN(dt.getTime());
}

/** Compact "Season 3, Episode 9 — Name" → "S3 E9 · Name" for the second line. */
export function compactUpcomingDetail(detail: unknown): string {
  const s = String(detail || "").trim();
  const m = s.match(/^Season\s+(\d+),\s*Episode\s+(\d+)\s*(?:[—–-]\s*(.+))?$/i);
  if (m?.[1] && m[2]) {
    const name = (m[3] || "").trim();
    return name ? `S${m[1]} E${m[2]} · ${name}` : `S${m[1]} E${m[2]}`;
  }
  return s;
}

/** YYYY-MM-DD from alert, or "" if invalid. */
export function getUpcomingAirDateYmd(alert: UpcomingAlert | Record<string, unknown>): string {
  const raw = getUpcomingAirDateString(alert);
  if (!raw || String(raw).toUpperCase() === "TBA") return "";
  const ymd = String(raw).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return "";
  return ymd;
}

export function icsEscapeText(str: string): string {
  return String(str || "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

/** Fold a single logical line to ≤75 octets per RFC 5545 (ASCII-safe). */
export function icsFoldLine(line: string): string {
  const max = 73;
  if (line.length <= max) return line;
  const out: string[] = [];
  let rest = line;
  let first = true;
  while (rest.length > 0) {
    const chunkLen = first ? max : max - 1;
    out.push(first ? rest.slice(0, chunkLen) : ` ${rest.slice(0, chunkLen)}`);
    rest = rest.slice(chunkLen);
    first = false;
  }
  return out.join("\r\n");
}

export function icsAllDayEndExclusiveYmd(ymd: string): string | null {
  const d = new Date(`${ymd}T12:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

export function buildUpcomingIcsDocument(opts: {
  ymd: string;
  title: string;
  detail: string;
  uid: string;
}): string | null {
  const { ymd, title, detail, uid } = opts;
  if (!ymd) return null;
  const start = ymd.replace(/-/g, "");
  if (start.length !== 8) return null;
  const endExcl = icsAllDayEndExclusiveYmd(ymd);
  if (!endExcl) return null;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const sum = icsFoldLine(`SUMMARY:${icsEscapeText(title || "Upcoming")}`);
  const uidSafe = String(uid || "upcoming").replace(/[^\w.-]/g, "-");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Watchlist//Upcoming//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${uidSafe}@watchlist-upcoming`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${start}`,
    `DTEND;VALUE=DATE:${endExcl}`,
    sum,
  ];
  const descRaw = String(detail || "").trim();
  if (descRaw) {
    lines.push(icsFoldLine(`DESCRIPTION:${icsEscapeText(descRaw)}`));
  }
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.join("\r\n");
}

export function safeIcsDownloadFilename(title: string): string {
  const base = String(title || "upcoming")
    .replace(/[\\/:*?"<>|]+/g, "")
    .trim()
    .slice(0, 72);
  const slug = base.replace(/\s+/g, "-").replace(/-+/g, "-") || "upcoming";
  return `${slug}.ics`;
}

export function downloadUpcomingIcs(icsBody: string, filename: string): void {
  const blob = new Blob([icsBody], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
