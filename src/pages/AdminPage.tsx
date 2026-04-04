import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  useRecommendationConfig,
  useUpdateRecommendationConfig,
  type RecommendationConfigEditable,
} from "../hooks/useRecommendationConfig.js";
import { RECOMMENDATION_CONFIG_DEFAULTS } from "../types/index.js";
import { Navigate, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/shadcn-utils";
import {
  runCheckUpcomingUntilComplete,
  UPCOMING_ADMIN_BATCH_PAUSE_MS,
} from "../lib/upcoming-admin-sync.js";
import { useAppStore } from "../store/useAppStore.js";
import { isAdmin } from "../config/admin.js";
import {
  auth,
  getFirestoreUsageStats,
  getJobConfigState,
  setCheckUpcomingEnabledState,
  setGithubBackupEnabledState,
  type FirestoreUsageStats,
} from "../firebase.js";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getCountFromServer,
  getDocs,
} from "firebase/firestore";

type DQTitleRow = {
  imdbId: string;
  title: string;
  year: number | string | null;
};

type DQThumbRow = DQTitleRow & { tmdbId: number | null };

type CatalogStats = {
  totalTitles: number | "Error";
  missingTmdbId: number | "Error";
  missingYoutubeId: number | "Error";
  missingThumb: number | "Error";
  missingTmdbMedia: number | "Error";
  missingTmdbIdTitles: DQTitleRow[];
  missingThumbTitles: DQThumbRow[];
  missingYoutubeIdTitles: DQTitleRow[];
  /** Shown in Data Quality detail panel for tmdbMedia gaps (same cap as other lists). */
  missingTmdbMediaTitles: DQTitleRow[];
};

type DQDetailKey = "tmdbId" | "thumb" | "tmdbMedia" | "youtubeId";

type DqPanelOpenKey = DQDetailKey | "orphans";

/** Collapsible panel order under Data Quality: thumb → tmdbMedia → youtubeId → tmdbId, then orphans. */
const DQ_COLLAPSIBLE_PANEL_ORDER: readonly DQDetailKey[] = [
  "thumb",
  "tmdbMedia",
  "youtubeId",
  "tmdbId",
];

type CatalogOrphansResponse = {
  ok: true;
  count: number;
  registryDocCount: number;
  referencedDistinctCount: number;
  orphans: { registryId: string; title: string; year: number | string | null }[];
  truncated: boolean;
  omitted: number;
};

function dqStrEmpty(v: unknown): boolean {
  return v == null || String(v).trim() === "";
}

function dqRowImdbId(data: Record<string, unknown>, docId: string): string {
  const raw = data.imdbId;
  if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
  return docId;
}

function dqRowTitle(data: Record<string, unknown>, docId: string): string {
  const raw = data.title;
  if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
  return docId;
}

/** Normalize registry id for comparison with `meta/catalogHealthExclusions.missingTmdbId`. */
function dqImdbIdKey(imdbId: string): string {
  return imdbId.trim().toLowerCase();
}

function dqParseTmdbIdFromRecord(tid: unknown): number | null {
  if (typeof tid === "number" && Number.isFinite(tid)) return tid;
  if (typeof tid === "string" && tid.trim() !== "" && !Number.isNaN(Number(tid)))
    return Number(tid);
  return null;
}

async function loadMissingTmdbIdExclusions(
  db: ReturnType<typeof getFirestore>
): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const exSnap = await getDoc(doc(db, "meta", "catalogHealthExclusions"));
    if (!exSnap.exists()) return out;
    const raw = exSnap.data()?.missingTmdbId;
    if (!Array.isArray(raw)) return out;
    for (const x of raw) {
      if (typeof x === "string" && x.trim() !== "") out.add(dqImdbIdKey(x));
    }
  } catch {
    /* missing doc or read error — treat as no exclusions */
  }
  return out;
}

function formatDqYear(y: number | string | null): string {
  if (y == null || y === "") return "—";
  return String(y);
}

function AdminDqStatValue({
  count,
  tone,
}: {
  count: number | "Error";
  tone: "critical" | "warn" | "neutral";
}) {
  if (count === "Error") {
    return (
      <div className="admin-stat-value admin-stat-value--small" role="status">
        Error
      </div>
    );
  }
  if (tone === "neutral") {
    return <div className="admin-stat-value">{count}</div>;
  }
  if (count === 0) {
    return (
      <div className="admin-stat-value admin-stat-value--dq-ok" aria-label="OK">
        ✓
      </div>
    );
  }
  const cls = tone === "critical" ? "admin-stat-value--dq-critical" : "admin-stat-value--dq-warn";
  return <div className={`admin-stat-value ${cls}`}>{count}</div>;
}

type DqPanelDef = {
  key: DQDetailKey;
  fieldLabel: string;
  count: number | "Error";
  rows: DQTitleRow[] | DQThumbRow[];
};

type DqGridItem = { kind: "panel"; def: DqPanelDef } | { kind: "orphans" };

function buildDqGridItems(
  visiblePanels: DqPanelDef[],
  includeOrphansCollapsible: boolean
): DqGridItem[] {
  const byKey = new Map<DQDetailKey, DqPanelDef>(visiblePanels.map((p) => [p.key, p] as const));
  const items: DqGridItem[] = [];
  for (const key of DQ_COLLAPSIBLE_PANEL_ORDER) {
    const def = byKey.get(key);
    if (def) items.push({ kind: "panel", def });
  }
  if (includeOrphansCollapsible) items.push({ kind: "orphans" });
  return items;
}

function buildDqPanelDefs(d: CatalogStats): DqPanelDef[] {
  return [
    { key: "tmdbId", fieldLabel: "tmdbId", count: d.missingTmdbId, rows: d.missingTmdbIdTitles },
    {
      key: "thumb",
      fieldLabel: "thumb",
      count: d.missingThumb,
      rows: d.missingThumbTitles,
    },
    {
      key: "tmdbMedia",
      fieldLabel: "tmdbMedia",
      count: d.missingTmdbMedia,
      rows: d.missingTmdbMediaTitles,
    },
    {
      key: "youtubeId",
      fieldLabel: "youtubeId",
      count: d.missingYoutubeId,
      rows: d.missingYoutubeIdTitles,
    },
  ];
}

type JobConfigState = {
  checkUpcomingEnabled: boolean;
  githubBackupEnabled: boolean;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunMessage: string | null;
  lastRunResult: Record<string, unknown> | null;
};

type GithubBackupLastRun = {
  status: string;
  conclusion: string | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  event: string;
  run_attempt?: number;
};

type GithubBackupStatusResponse = {
  ok: boolean;
  error?: string;
  repo?: string;
  workflowFile?: string;
  workflowName?: string;
  actionsUrl?: string;
  lastRun: GithubBackupLastRun | null;
  githubError?: string;
  githubHttpStatus?: number;
};

type VercelDeploymentLast = {
  state: string;
  createdAt: number | string | null;
  url: string;
  meta?: { githubCommitMessage?: string };
};

type VercelDeploymentStatusResponse = {
  ok: boolean;
  error?: string;
  lastDeployment: VercelDeploymentLast | null;
  vercelError?: string;
  vercelHttpStatus?: number;
};

/** Success payload from `GET /api/admin/external-status?service=gcs` (errors throw from `fetchAdminExternalStatus`). */
type GcsBackupStatusResponse = {
  ok: true;
  lastExportAt: string;
  folderName: string;
  status: "success" | "warning";
};

const GCS_BACKUP_CONSOLE_URL =
  "https://console.cloud.google.com/storage/browser/movie-trailer-site-backups";

/** Admin Activity card — same workspace as Service Links → Axiom Dashboards. */
const AXIOM_ACTIVITY_DASHBOARD_URL = "https://app.axiom.co/maulbogat-riv8/dashboards";

const FIREBASE_FIRESTORE_USAGE_CONSOLE_URL =
  "https://console.firebase.google.com/u/0/project/movie-trailer-site/firestore/usage";

/** Success payload from `GET /api/admin/external-status?service=axiom` (errors throw from `fetchAdminExternalStatus`). */
type AxiomActivityResponse = {
  ok: true;
  firestoreReads: number;
  apiCalls: number;
  userActions: number;
  errors: number;
  titlesAdded: number;
  period: "24h";
};

const ACTIVITY_STAT_CARD_COUNT = 4;

/** Admin Sentry card — issues list (same org as Service Links). */
const SENTRY_ISSUES_HUB_URL = "https://maulbogat.sentry.io/issues/";

/** Success payload from `GET /api/admin/external-status?service=sentry` (errors throw from `fetchAdminExternalStatus`). */
type SentryIssuesSummaryResponse = {
  ok: true;
  errorCount: number;
  period: "24h";
};

/** Production site origin (bookmarklet / admin links). Override with VITE_APP_ORIGIN when your host differs. */
const DEFAULT_APP_ORIGIN = "https://watchlist.maulbogat.com";
const appOrigin =
  (import.meta.env.VITE_APP_ORIGIN as string | undefined)?.trim() || DEFAULT_APP_ORIGIN;
const isLocal =
  window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
const switchHref = isLocal ? `${appOrigin}/admin` : `http://localhost:5173/admin`;
const switchLabel = isLocal ? "Switch to prod" : "Switch to local";

/** Service Links row: single external URL, or grouped entry points under one card. */
type AdminServiceLinkSingle = { label: string; sublabel: string; url: string };
type AdminServiceLinkMulti = {
  label: string;
  sublabel: string;
  links: ReadonlyArray<{ label: string; url: string }>;
};
type AdminServiceLinkEntry = AdminServiceLinkSingle | AdminServiceLinkMulti;

const SERVICE_LINKS: readonly AdminServiceLinkEntry[] = [
  {
    label: "Firestore",
    sublabel: "Database",
    links: [
      {
        label: "Firebase console",
        url: "https://console.firebase.google.com/u/0/project/movie-trailer-site/firestore/databases/-default-/data/",
      },
      {
        label: "GCP Studio",
        url: "https://console.cloud.google.com/firestore/databases/-default-/data/panel/allowedUsers/geo80637@gmail.com?project=movie-trailer-site",
      },
    ],
  },
  {
    label: "Vercel",
    sublabel: "Hosting",
    links: [
      {
        label: "Env Vars",
        url: "https://vercel.com/maulbogats-projects/watchlist/settings/environment-variables",
      },
      {
        label: "Function Logs",
        url: "https://vercel.com/maulbogats-projects/watchlist/logs",
      },
    ],
  },
  {
    label: "Resend",
    sublabel: "Emails",
    url: "https://resend.com/emails",
  },
  {
    label: "Meta",
    sublabel: "WhatsApp",
    links: [
      {
        label: "WhatsApp API",
        url: "https://developers.facebook.com/apps/1104781941831455/use_cases/customize/wa-settings/?use_case_enum=WHATSAPP_BUSINESS_MESSAGING&product_route=whatsapp-business&business_id=762125852300048&selected_tab=wa-dev-console",
      },
      {
        label: "System Users",
        url: "https://business.facebook.com/latest/settings/system_users?business_id=762125852300048&selected_user_id=61576462286852",
      },
    ],
  },
  {
    label: "Google Cloud",
    sublabel: "Infrastructure",
    links: [
      {
        label: "Project dashboard",
        url: "https://console.cloud.google.com/home/dashboard?project=movie-trailer-site",
      },
      {
        label: "Billing",
        url: "https://console.cloud.google.com/billing/0145FD-CB6342-6B19AD",
      },
      {
        label: "Cloud Scheduler",
        url: "https://console.cloud.google.com/cloudscheduler?project=movie-trailer-site",
      },
    ],
  },
  {
    label: "Cloudflare",
    sublabel: "Dashboard",
    url: "https://dash.cloudflare.com/a32df282319e2330a05f8a4511017022/home/overview",
  },
  {
    label: "GitHub",
    sublabel: "Project Repository",
    url: "https://github.com/maulbogat/watchlist-app",
  },
  {
    label: "TMDB",
    sublabel: "API Settings",
    url: "https://www.themoviedb.org/settings/api",
  },
  {
    label: "Trakt",
    sublabel: "OAuth App",
    url: "https://trakt.tv/oauth/applications/189759",
  },
  {
    label: "Notion",
    sublabel: "Project Management",
    url: "https://www.notion.so/1a114e9ce7a34dcab5cae4e52ef180c2?v=787e39f04dba4825932d2c74fd1aebe0",
  },
  {
    label: "Axiom",
    sublabel: "Observability",
    links: [
      {
        label: "Log Stream",
        url: "https://app.axiom.co/maulbogat-riv8/stream/watchlist-prod",
      },
      {
        label: "Monitors",
        url: "https://app.axiom.co/maulbogat-riv8/monitors",
      },
    ],
  },
];

const rawViteDeploymentsUrl = (import.meta.env.VITE_DEPLOYMENTS_URL as string | undefined)?.trim();
const deploymentsUrl =
  rawViteDeploymentsUrl || "https://vercel.com/maulbogats-projects/watchlist/deployments";
const hasCustomDeploymentsUrl = Boolean(rawViteDeploymentsUrl);

type MaybeSelectable<T> = T & {
  select?: (...fields: string[]) => T;
};

function toEpochMs(value: unknown): number | null {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  if (typeof value === "object" && value !== null && "toDate" in value) {
    const maybeTs = value as { toDate?: () => Date };
    const d = maybeTs.toDate?.();
    return d instanceof Date ? d.getTime() : null;
  }
  return null;
}

function formatDateTime(ms: number | null): string | null {
  if (ms == null) return null;
  const date = new Date(ms);
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = String(date.getFullYear());
  const time = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return `${day}/${month}/${year}, ${time}`;
}

function formatTitleCaseWords(s: string): string {
  const t = s.trim();
  if (!t) return "";
  return t
    .replace(/_/g, " ")
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

const GITHUB_EVENT_LABEL: Record<string, string> = {
  schedule: "Scheduled",
  workflow_dispatch: "Manual",
  push: "Push",
  pull_request: "Pull request",
  release: "Release",
};

function formatGithubRunStatus(status: string): string {
  return formatTitleCaseWords(status);
}

function formatGithubEvent(event: string): string {
  return GITHUB_EVENT_LABEL[event] ?? formatTitleCaseWords(event);
}

function vercelCreatedToMs(createdAt: unknown): number | null {
  if (createdAt == null) return null;
  if (typeof createdAt === "number" && Number.isFinite(createdAt)) return createdAt;
  if (typeof createdAt === "string") {
    const trimmed = createdAt.trim();
    const asNum = Number(trimmed);
    if (Number.isFinite(asNum) && trimmed === String(asNum)) return asNum;
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

const VERCEL_COMMIT_PREVIEW_MAX = 72;

function truncateCommitMessage(raw: string | undefined | null): string {
  const t = String(raw ?? "").trim();
  if (!t) return "—";
  if (t.length <= VERCEL_COMMIT_PREVIEW_MAX) return t;
  return `${t.slice(0, VERCEL_COMMIT_PREVIEW_MAX)}...`;
}

function vercelStatusBadge(state: string): { label: string; className: string } {
  const s = String(state || "").toUpperCase();
  if (s === "READY") {
    return { label: "SUCCESS", className: "admin-job-status admin-job-status--on" };
  }
  if (s === "ERROR" || s === "CANCELED") {
    return { label: "ERROR", className: "admin-job-status admin-job-status--failure" };
  }
  if (!s) {
    return { label: "—", className: "admin-job-value" };
  }
  return { label: s, className: "admin-job-status" };
}

function gcsBackupStatusBadge(status: "success" | "warning"): { label: string; className: string } {
  if (status === "success") {
    return { label: "SUCCESS", className: "admin-job-status admin-job-status--on" };
  }
  return { label: "WARNING", className: "admin-job-status admin-job-status--warn" };
}

/** Firestore read sum vs daily quota bands (green / gold / red). */
function axiomFirestoreReadsValueClass(n: number): string {
  if (n > 45000) return "admin-stat-value admin-stat-value--dq-critical";
  if (n > 40000) return "admin-stat-value admin-stat-value--dq-warn";
  return "admin-stat-value admin-stat-value--dq-ok";
}

function axiomErrorsValueDisplay(count: number): { className: string; content: string } {
  if (count === 0) {
    return { className: "admin-stat-value admin-stat-value--dq-ok", content: "✓" };
  }
  return { className: "admin-stat-value admin-stat-value--dq-critical", content: String(count) };
}

function AxiomActivityErrorsStat({ count }: { count: number }) {
  const e = axiomErrorsValueDisplay(count);
  return (
    <div className={e.className} aria-label={count === 0 ? "No errors" : undefined}>
      {e.content}
    </div>
  );
}

function AdminVercelDeploymentSummary({ dep }: { dep: VercelDeploymentLast }) {
  const status = vercelStatusBadge(dep.state);
  return (
    <>
      <div className="admin-job-row admin-job-row--status-line">
        <span className="admin-stat-label">Status</span>
        <span className={status.className}>{status.label}</span>
      </div>
      <div className="admin-job-row">
        <span className="admin-stat-label">Created</span>
        <span className="admin-job-value">
          {formatDateTime(vercelCreatedToMs(dep.createdAt)) || "—"}
        </span>
      </div>
      <div className="admin-job-row admin-job-row--align-start">
        <span className="admin-stat-label">Commit</span>
        <span className="admin-job-value">
          {truncateCommitMessage(dep.meta?.githubCommitMessage)}
        </span>
      </div>
    </>
  );
}

function formatUpcomingLastRunLine(
  status: string | null | undefined,
  message: string | null | undefined
): string {
  const st = status?.trim();
  const msg = message?.trim();
  if (!st && !msg) return "N/A";
  const head = st ? formatTitleCaseWords(st.replace(/_/g, " ")) : "";
  if (!msg) return head || "N/A";
  return head ? `${head} — ${msg}` : msg;
}

/** Defaults match `src/api-lib/firestore-guard.js` and `.env.example`. */
const FIRESTORE_USAGE_HOURLY_LIMIT = 5000;
const FIRESTORE_USAGE_DAILY_LIMIT = 45000;

function usagePercent(current: number, limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.min(100, (current / limit) * 100);
}

function usageBarColor(percent: number): string {
  if (percent > 80) return "var(--color-red)";
  if (percent >= 50) return "var(--color-gold)";
  return "var(--color-success)";
}

function formatUsageUpdatedAt(stats: FirestoreUsageStats | null | undefined): string {
  if (!stats?.updatedAt?.trim()) return "N/A";
  const ms = toEpochMs(stats.updatedAt);
  return formatDateTime(ms) || stats.updatedAt;
}

const DQ_STAT_CARD_COUNT = 5;

/** Orphan row shrink/fade-out duration before Firestore queries refetch (ms). */
const ORPHAN_ROW_EXIT_MS = 300;

/** Matches `MAX_ORPHANS_IN_RESPONSE` in `api/admin/[segment].js` (catalog-orphans). */
const ADMIN_CATALOG_ORPHANS_CAP = 1500;

const ADMIN_CATALOG_ORPHANS_SESSION_KEY = "watchlist-admin-catalog-orphans-v1";

function readCatalogOrphansSession(): CatalogOrphansResponse | undefined {
  try {
    const raw = sessionStorage.getItem(ADMIN_CATALOG_ORPHANS_SESSION_KEY);
    if (!raw) return undefined;
    const p = JSON.parse(raw) as CatalogOrphansResponse;
    if (p?.ok !== true || typeof p.count !== "number" || !Array.isArray(p.orphans))
      return undefined;
    return p;
  } catch {
    return undefined;
  }
}

function persistCatalogOrphansSession(queryClient: QueryClient): void {
  try {
    const d = queryClient.getQueryData<CatalogOrphansResponse>(["admin", "catalog-orphans"]);
    if (d?.ok) sessionStorage.setItem(ADMIN_CATALOG_ORPHANS_SESSION_KEY, JSON.stringify(d));
  } catch {
    /* sessionStorage quota / private mode */
  }
}

/** After exit animation, drop the row from the cached list (no orphan rescan). */
function removeOrphanRowFromCatalogOrphansCache(
  queryClient: QueryClient,
  registryId: string
): void {
  queryClient.setQueryData<CatalogOrphansResponse>(["admin", "catalog-orphans"], (prev) => {
    if (!prev?.ok) return prev;
    return { ...prev, orphans: prev.orphans.filter((o) => o.registryId !== registryId) };
  });
}

/**
 * Decrement orphan stats immediately after a successful delete so counts stay in sync.
 * The `orphans` list is left unchanged until exit animation finishes.
 */
function applyOrphanDeletedToCatalogOrphansCache(queryClient: QueryClient): void {
  queryClient.setQueryData<CatalogOrphansResponse>(["admin", "catalog-orphans"], (prev) => {
    if (!prev?.ok) return prev;
    const count = Math.max(0, prev.count - 1);
    const registryDocCount = Math.max(0, prev.registryDocCount - 1);
    const truncated = count > ADMIN_CATALOG_ORPHANS_CAP;
    const omitted = truncated ? Math.max(0, count - ADMIN_CATALOG_ORPHANS_CAP) : 0;
    return {
      ...prev,
      count,
      registryDocCount,
      truncated,
      omitted,
    };
  });
}

async function fetchAdminExternalStatus<T extends { ok?: boolean; error?: string }>(
  path: string
): Promise<T> {
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in");
  const idToken = await user.getIdToken();
  const res = await fetch(path, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  const data = (await res.json()) as T;
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  if (data.ok === false && data.error) {
    throw new Error(data.error);
  }
  return data;
}

type RecConfigField = {
  key: keyof RecommendationConfigEditable;
  label: string;
  tooltip: string;
  type: "number" | "boolean";
  min?: number;
  max?: number;
  step?: number;
};

type RecConfigGroup = {
  title: string;
  fields: RecConfigField[];
};

const REC_CONFIG_GROUPS: RecConfigGroup[] = [
  {
    title: "Quality Filter",
    fields: [
      {
        key: "minRating",
        label: "Min rating",
        tooltip: "Minimum TMDB rating (0–10) a title must have to be considered as a recommendation.",
        type: "number",
        min: 0,
        max: 10,
        step: 0.1,
      },
      {
        key: "minVotesEn",
        label: "Min votes (English)",
        tooltip:
          "Minimum number of TMDB votes required for English-language titles. Higher bar because more data is available.",
        type: "number",
        min: 0,
        step: 100,
      },
      {
        key: "minVotesForeign",
        label: "Min votes (Foreign)",
        tooltip:
          "Minimum number of TMDB votes required for non-English titles. Lower bar to account for less global coverage.",
        type: "number",
        min: 0,
        step: 100,
      },
    ],
  },
  {
    title: "Pool Size",
    fields: [
      {
        key: "poolSize",
        label: "Pool size",
        tooltip:
          "How many candidate titles are scored and ranked before the final recommendation list is cut. A larger pool increases diversity at the cost of more computation.",
        type: "number",
        min: 10,
        max: 1000,
        step: 10,
      },
    ],
  },
  {
    title: "Status Weights",
    fields: [
      {
        key: "wFavorite",
        label: "Favorite weight",
        tooltip:
          "Score multiplier applied when a candidate is similar to a favorited title (watched and liked). Higher = stronger signal.",
        type: "number",
        min: 0,
        max: 5,
        step: 0.1,
      },
      {
        key: "wWatched",
        label: "Watched weight",
        tooltip:
          "Score multiplier for similarity to neutrally-watched titles (no explicit like/dislike).",
        type: "number",
        min: 0,
        max: 5,
        step: 0.1,
      },
      {
        key: "wUnliked",
        label: "Unliked weight",
        tooltip:
          "Score multiplier for similarity to disliked titles. Keep low so similar content is down-ranked. (Future — dislike data not yet in the data model.)",
        type: "number",
        min: 0,
        max: 5,
        step: 0.1,
      },
      {
        key: "wUnwatched",
        label: "Unwatched weight",
        tooltip:
          "Score multiplier for similarity to to-watch / maybe-later items. Currently excluded from scoring; set > 0 to include.",
        type: "number",
        min: 0,
        max: 5,
        step: 0.1,
      },
    ],
  },
  {
    title: "Diversity",
    fields: [
      {
        key: "diversityEnabled",
        label: "Diversity enabled",
        tooltip:
          "When on, over-represented genres and directors are penalised so the final list spans a broader range of content.",
        type: "boolean",
      },
    ],
  },
  {
    title: "Position Weighting (future)",
    fields: [
      {
        key: "positionWeightEnabled",
        label: "Position weight enabled",
        tooltip:
          "When on, titles added earlier in a list contribute less signal than recently-added titles. Not yet implemented — toggling this has no effect until the pipeline supports it.",
        type: "boolean",
      },
    ],
  },
];

function formatRecConfigUpdatedAt(
  updatedAt: { toDate: () => Date } | null | undefined
): string {
  if (!updatedAt) return "Never";
  try {
    const d = updatedAt.toDate();
    return d.toLocaleString(undefined, {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "Unknown";
  }
}

function RecommendationSettingsSection() {
  const configQ = useRecommendationConfig();
  const updateM = useUpdateRecommendationConfig();

  const [form, setForm] = useState<RecommendationConfigEditable>(RECOMMENDATION_CONFIG_DEFAULTS);
  const [isDirty, setIsDirty] = useState(false);

  useEffect(() => {
    if (configQ.data) {
      const { updatedAt: _updatedAt, updatedBy: _updatedBy, algorithmVersion: _av, ...editable } =
        configQ.data;
      setForm(editable);
      setIsDirty(false);
    }
  }, [configQ.data]);

  function handleNumberChange(key: keyof RecommendationConfigEditable, raw: string) {
    const value = parseFloat(raw);
    if (!Number.isNaN(value)) {
      setForm((prev) => ({ ...prev, [key]: value }));
      setIsDirty(true);
    }
  }

  function handleBooleanChange(key: keyof RecommendationConfigEditable, checked: boolean) {
    setForm((prev) => ({ ...prev, [key]: checked }));
    setIsDirty(true);
  }

  function handleSave() {
    updateM.mutate(form, {
      onSuccess: () => {
        toast.success("Recommendation settings saved");
        setIsDirty(false);
      },
      onError: (err) => {
        toast.error(err instanceof Error ? err.message : "Failed to save settings");
      },
    });
  }

  const updatedAt = configQ.data?.updatedAt ?? null;
  const updatedBy = configQ.data?.updatedBy ?? "";

  return (
    <section className="admin-section admin-section--rec-config">
      <h2>Recommendation Algorithm Settings</h2>
      <div className="admin-card admin-job-card">
        {configQ.isPending ? (
          <p className="admin-job-result">Loading…</p>
        ) : configQ.isError ? (
          <p className="admin-job-result">Failed to load config</p>
        ) : (
          <>
            {REC_CONFIG_GROUPS.map((group) => (
              <div key={group.title} className="admin-rec-group">
                <p className="admin-rec-group-title">{group.title}</p>
                {group.fields.map((field) => (
                  <div key={field.key} className="admin-job-row" title={field.tooltip}>
                    <span className="admin-rec-field-label">{field.label}</span>
                    {field.type === "boolean" ? (
                      <button
                        type="button"
                        role="switch"
                        aria-checked={Boolean(form[field.key])}
                        className={cn(
                          "admin-rec-toggle-switch",
                          Boolean(form[field.key]) && "admin-rec-toggle-switch--on"
                        )}
                        onClick={() => handleBooleanChange(field.key, !Boolean(form[field.key]))}
                      >
                        <span className="admin-rec-toggle-thumb" />
                        <span className="admin-rec-toggle-label">
                          {form[field.key] ? "On" : "Off"}
                        </span>
                      </button>
                    ) : (
                      <input
                        className="admin-rec-number-input"
                        type="number"
                        value={Number(form[field.key])}
                        min={field.min}
                        max={field.max}
                        step={field.step ?? 1}
                        onChange={(e) => handleNumberChange(field.key, e.target.value)}
                      />
                    )}
                  </div>
                ))}
              </div>
            ))}

            <p className="admin-job-hint">Changes take effect on next pipeline run.</p>

            <div className="admin-rec-footer">
              <span className="admin-stat-label">
                Last updated: {formatRecConfigUpdatedAt(updatedAt)}
                {updatedBy ? ` · ${updatedBy}` : ""}
              </span>
              <button
                type="button"
                className={cn("btn-primary", (updateM.isPending || !isDirty) && "admin-rec-save-btn--disabled")}
                disabled={updateM.isPending || !isDirty}
                onClick={handleSave}
              >
                {updateM.isPending ? "Saving…" : "Save"}
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

export function AdminPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const currentUser = useAppStore((s) => s.currentUser);
  const userIsAdmin = isAdmin(currentUser?.uid);

  const [catalogOrphansInitial] = useState<CatalogOrphansResponse | undefined>(() =>
    readCatalogOrphansSession()
  );
  const [orphanScanBusy, setOrphanScanBusy] = useState(false);
  const [orphanScanError, setOrphanScanError] = useState<string | null>(null);

  const catalogStatsQ = useQuery<CatalogStats>({
    queryKey: ["admin", "catalog-stats"],
    staleTime: 60 * 1000,
    enabled: userIsAdmin,
    queryFn: async () => {
      const emptyLists = (): Pick<
        CatalogStats,
        | "missingTmdbIdTitles"
        | "missingThumbTitles"
        | "missingYoutubeIdTitles"
        | "missingTmdbMediaTitles"
      > => ({
        missingTmdbIdTitles: [],
        missingThumbTitles: [],
        missingYoutubeIdTitles: [],
        missingTmdbMediaTitles: [],
      });

      const base: CatalogStats = {
        totalTitles: "Error",
        missingTmdbId: "Error",
        missingYoutubeId: "Error",
        missingThumb: "Error",
        missingTmdbMedia: "Error",
        ...emptyLists(),
      };

      try {
        const db = getFirestore();
        const titleRegistryRef = collection(db, "titleRegistry");
        const totalTitlesSnap = await getCountFromServer(titleRegistryRef);
        base.totalTitles = totalTitlesSnap.data().count;

        const projectedRegistryRef =
          (titleRegistryRef as MaybeSelectable<typeof titleRegistryRef>).select?.(
            "tmdbId",
            "youtubeId",
            "thumb",
            "tmdbMedia",
            "title",
            "year",
            "imdbId",
            "type"
          ) ?? titleRegistryRef;
        const registrySnap = await getDocs(projectedRegistryRef);
        const missingTmdbIdExcluded = await loadMissingTmdbIdExclusions(db);
        let missingTmdbId = 0;
        let missingYoutubeId = 0;
        let missingThumb = 0;
        let missingTmdbMedia = 0;
        const missingTmdbIdTitles: DQTitleRow[] = [];
        const missingThumbTitles: DQThumbRow[] = [];
        const missingYoutubeIdTitles: DQTitleRow[] = [];
        const missingTmdbMediaTitles: DQTitleRow[] = [];
        const maxTitles = 20;

        registrySnap.forEach((d) => {
          const rec = d.data() as Record<string, unknown>;
          const imdbId = dqRowImdbId(rec, d.id);
          const title = dqRowTitle(rec, d.id);
          const year =
            typeof rec.year === "number" || typeof rec.year === "string"
              ? (rec.year as number | string)
              : null;

          const noTmdbId = rec.tmdbId == null || rec.tmdbId === "";
          const skipTmdbGap = noTmdbId && missingTmdbIdExcluded.has(dqImdbIdKey(imdbId));
          if (noTmdbId && !skipTmdbGap) {
            missingTmdbId += 1;
            if (missingTmdbIdTitles.length < maxTitles) {
              missingTmdbIdTitles.push({ imdbId, title, year });
            }
          }

          if (rec.youtubeId == null || rec.youtubeId === "") {
            missingYoutubeId += 1;
            if (missingYoutubeIdTitles.length < maxTitles) {
              missingYoutubeIdTitles.push({ imdbId, title, year });
            }
          }

          if (dqStrEmpty(rec.thumb)) {
            missingThumb += 1;
            if (missingThumbTitles.length < maxTitles) {
              missingThumbTitles.push({
                imdbId,
                title,
                year,
                tmdbId: dqParseTmdbIdFromRecord(rec.tmdbId),
              });
            }
          }

          if (dqStrEmpty(rec.tmdbMedia)) {
            missingTmdbMedia += 1;
            if (missingTmdbMediaTitles.length < maxTitles) {
              missingTmdbMediaTitles.push({ imdbId, title, year });
            }
          }
        });

        base.missingTmdbId = missingTmdbId;
        base.missingYoutubeId = missingYoutubeId;
        base.missingThumb = missingThumb;
        base.missingTmdbMedia = missingTmdbMedia;
        base.missingTmdbIdTitles = missingTmdbIdTitles;
        base.missingThumbTitles = missingThumbTitles;
        base.missingYoutubeIdTitles = missingYoutubeIdTitles;
        base.missingTmdbMediaTitles = missingTmdbMediaTitles;
      } catch (err) {
        console.error("Admin catalog/titleRegistry stats failed:", err);
      }

      return base;
    },
  });

  const catalogOrphansQ = useQuery<CatalogOrphansResponse>({
    queryKey: ["admin", "catalog-orphans"],
    enabled: false,
    ...(catalogOrphansInitial ? { initialData: catalogOrphansInitial } : {}),
    queryFn: () => fetchAdminExternalStatus<CatalogOrphansResponse>("/api/admin/catalog-orphans"),
  });

  const runCatalogOrphansScan = useCallback(async () => {
    setOrphanScanError(null);
    setOrphanScanBusy(true);
    try {
      const data = await fetchAdminExternalStatus<CatalogOrphansResponse>(
        "/api/admin/catalog-orphans"
      );
      queryClient.setQueryData(["admin", "catalog-orphans"], data);
      persistCatalogOrphansSession(queryClient);
    } catch (e) {
      setOrphanScanError(e instanceof Error ? e.message : "Scan failed");
    } finally {
      setOrphanScanBusy(false);
    }
  }, [queryClient]);

  const [dqPanelsOpen, setDqPanelsOpen] = useState<Record<DqPanelOpenKey, boolean>>({
    tmdbId: false,
    thumb: false,
    tmdbMedia: false,
    youtubeId: false,
    orphans: false,
  });
  const [orphanExitingIds, setOrphanExitingIds] = useState<string[]>([]);
  /** Each row keeps its spinner until its own delete request settles (supports parallel deletes). */
  const [orphanDeleteInFlightIds, setOrphanDeleteInFlightIds] = useState<Set<string>>(
    () => new Set()
  );
  const orphanExitTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    return () => {
      for (const t of orphanExitTimersRef.current.values()) clearTimeout(t);
      orphanExitTimersRef.current.clear();
    };
  }, []);

  const deleteRegistryOrphanM = useMutation({
    mutationFn: async (registryId: string) => {
      const user = auth.currentUser;
      if (!user) throw new Error("Not signed in");
      const idToken = await user.getIdToken();
      const res = await fetch("/api/admin/delete-registry-orphan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ registryId }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || `Request failed (${res.status})`);
      }
    },
    onMutate: (registryId) => {
      setOrphanDeleteInFlightIds((prev) => {
        const next = new Set(prev);
        next.add(registryId);
        return next;
      });
    },
    onSettled: (_data, _err, registryId) => {
      setOrphanDeleteInFlightIds((prev) => {
        const next = new Set(prev);
        next.delete(registryId);
        return next;
      });
    },
    onSuccess: (_void, registryId) => {
      applyOrphanDeletedToCatalogOrphansCache(queryClient);
      setOrphanExitingIds((prev) => (prev.includes(registryId) ? prev : [...prev, registryId]));
      const prevTimer = orphanExitTimersRef.current.get(registryId);
      if (prevTimer) clearTimeout(prevTimer);
      const t = setTimeout(() => {
        orphanExitTimersRef.current.delete(registryId);
        removeOrphanRowFromCatalogOrphansCache(queryClient, registryId);
        persistCatalogOrphansSession(queryClient);
        void queryClient.invalidateQueries({ queryKey: ["admin", "catalog-stats"] });
        setOrphanExitingIds((prev) => prev.filter((id) => id !== registryId));
      }, ORPHAN_ROW_EXIT_MS);
      orphanExitTimersRef.current.set(registryId, t);
    },
    onError: (err) => {
      console.error("Delete registry orphan failed:", err);
    },
  });

  const firestoreUsageQ = useQuery<FirestoreUsageStats | null>({
    queryKey: ["admin", "firestore-usage-stats"],
    staleTime: 0,
    refetchOnMount: "always",
    enabled: userIsAdmin,
    queryFn: getFirestoreUsageStats,
  });

  const jobConfigQ = useQuery<JobConfigState>({
    queryKey: ["admin", "job-config"],
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    enabled: userIsAdmin,
    queryFn: () => getJobConfigState(),
  });

  const githubBackupQ = useQuery<GithubBackupStatusResponse>({
    queryKey: ["admin", "external-status", "github"],
    staleTime: 60 * 1000,
    enabled: userIsAdmin,
    queryFn: () =>
      fetchAdminExternalStatus<GithubBackupStatusResponse>(
        "/api/admin/external-status?service=github"
      ),
  });

  const vercelDeploymentQ = useQuery<VercelDeploymentStatusResponse>({
    queryKey: ["admin", "external-status", "vercel"],
    staleTime: 0,
    refetchOnMount: "always",
    enabled: userIsAdmin,
    queryFn: () =>
      fetchAdminExternalStatus<VercelDeploymentStatusResponse>(
        "/api/admin/external-status?service=vercel"
      ),
  });

  const gcsBackupQ = useQuery<GcsBackupStatusResponse>({
    queryKey: ["admin", "external-status", "gcs"],
    staleTime: 60 * 1000,
    enabled: userIsAdmin,
    queryFn: () =>
      fetchAdminExternalStatus<GcsBackupStatusResponse>("/api/admin/external-status?service=gcs"),
  });

  const axiomActivityQ = useQuery<AxiomActivityResponse>({
    queryKey: ["admin", "external-status", "axiom"],
    staleTime: 0,
    refetchOnMount: "always",
    enabled: userIsAdmin,
    queryFn: () =>
      fetchAdminExternalStatus<AxiomActivityResponse>("/api/admin/external-status?service=axiom"),
  });

  const sentryIssuesQ = useQuery<SentryIssuesSummaryResponse>({
    queryKey: ["admin", "external-status", "sentry"],
    staleTime: 0,
    refetchOnMount: "always",
    enabled: userIsAdmin,
    queryFn: () =>
      fetchAdminExternalStatus<SentryIssuesSummaryResponse>(
        "/api/admin/external-status?service=sentry"
      ),
  });

  const [runNowResult, setRunNowResult] = useState<string | null>(null);
  const [runUpcomingProgress, setRunUpcomingProgress] = useState<string | null>(null);
  const runNowTimerRef = useRef<number | null>(null);
  const runUpcomingAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => {
      if (runNowTimerRef.current) window.clearTimeout(runNowTimerRef.current);
    };
  }, []);

  function showRunNowResult(message: string, dismissMs: number = 10_000) {
    setRunNowResult(message);
    if (runNowTimerRef.current) window.clearTimeout(runNowTimerRef.current);
    runNowTimerRef.current = window.setTimeout(() => {
      setRunNowResult(null);
      runNowTimerRef.current = null;
    }, dismissMs);
  }

  const toggleJobMutation = useMutation({
    mutationFn: async (enabled: boolean) => setCheckUpcomingEnabledState(enabled),
    onSuccess: () => {
      void jobConfigQ.refetch();
    },
    onError: (err: Error) => {
      showRunNowResult(err.message || "Failed to update job state");
    },
  });

  const toggleGithubBackupMutation = useMutation({
    mutationFn: async (enabled: boolean) => setGithubBackupEnabledState(enabled),
    onSuccess: () => {
      void jobConfigQ.refetch();
    },
    onError: (err: Error) => {
      showRunNowResult(err.message || "Failed to update GitHub backup job state");
    },
  });

  const runNowMutation = useMutation({
    onMutate: () => {
      runUpcomingAbortRef.current?.abort();
      runUpcomingAbortRef.current = new AbortController();
      setRunUpcomingProgress(null);
    },
    mutationFn: async () => {
      const signal = runUpcomingAbortRef.current?.signal;
      if (!signal) throw new Error("Could not start run");
      return runCheckUpcomingUntilComplete({
        signal,
        onProgress: ({ batch, last }) => {
          const phase =
            last.skipped === true
              ? "skipped"
              : last.completed === true
                ? "complete"
                : last.completed === false
                  ? "partial"
                  : "…";
          setRunUpcomingProgress(`Batch ${batch} (${phase})…`);
        },
      });
    },
    onSuccess: (data) => {
      setRunUpcomingProgress(null);
      runUpcomingAbortRef.current = null;
      if (!data.ok) {
        showRunNowResult(
          data.error === "Cancelled" ? "Cancelled" : data.error || "Run failed",
          data.error === "Cancelled" ? 8000 : 12_000
        );
        void jobConfigQ.refetch();
        return;
      }
      if (data.skipped) {
        showRunNowResult(data.reason || "Skipped");
        void jobConfigQ.refetch();
        return;
      }
      const { batches, totals } = data;
      const suffix =
        batches > 1
          ? ` — ${batches} server batches (paused between batches for TMDB rate limits)`
          : "";
      showRunNowResult(
        `Full sync finished${suffix} — wrote ${totals.alertsUpserted}, skipped ${totals.writesSkipped} unchanged writes (${totals.rowsChecked} registry rows visited)`,
        25_000
      );
      void jobConfigQ.refetch();
    },
    onError: (err: Error) => {
      setRunUpcomingProgress(null);
      runUpcomingAbortRef.current = null;
      showRunNowResult(err.message || "Failed to run check-upcoming");
      void jobConfigQ.refetch();
    },
  });

  const jobErrorText = jobConfigQ.isError
    ? jobConfigQ.error instanceof Error && jobConfigQ.error.message
      ? jobConfigQ.error.message
      : "Could not load job config."
    : null;

  const catalogDq = catalogStatsQ.data;
  const dqStatCards = !catalogStatsQ.isPending
    ? [
        {
          label: "Total titles in catalog",
          count: catalogDq?.totalTitles ?? "Error",
          tone: "neutral" as const,
        },
        {
          label: "Missing tmdbId",
          count: catalogDq?.missingTmdbId ?? "Error",
          tone: "critical" as const,
        },
        {
          label: "Missing thumb",
          count: catalogDq?.missingThumb ?? "Error",
          tone: "warn" as const,
        },
        {
          label: "Missing tmdbMedia",
          count: catalogDq?.missingTmdbMedia ?? "Error",
          tone: "warn" as const,
        },
        {
          label: "Missing youtubeId",
          count: catalogDq?.missingYoutubeId ?? "Error",
          tone: "warn" as const,
        },
      ]
    : null;
  const dqVisiblePanels =
    catalogDq != null
      ? buildDqPanelDefs(catalogDq).filter((p) => typeof p.count === "number" && p.count > 0)
      : [];

  const dqGridItems = buildDqGridItems(dqVisiblePanels, userIsAdmin);
  const catalogOrphansData = catalogOrphansQ.data;
  const hasCatalogOrphansScanResult = catalogOrphansData?.ok === true;

  if (!userIsAdmin) {
    return <Navigate to="/" replace />;
  }

  return (
    <main className="admin-page">
      <header className="admin-header">
        <h1>Admin</h1>
        <p className="admin-subtitle">{currentUser?.email || "Unknown email"}</p>
        <a href={switchHref} className="admin-env-switch" target="_blank" rel="noopener noreferrer">
          {switchLabel} ↗
        </a>
      </header>

      <section className="admin-section admin-section--jobs-deploy">
        <h2>System Status</h2>
        <div className="admin-jobs-deploy-grid">
          <div className="admin-jobs-deploy-col">
            <h2>Upcoming Check Job</h2>
            <div className="admin-card admin-job-card">
              {jobConfigQ.isPending ? (
                <p className="admin-job-result">Loading job config…</p>
              ) : jobConfigQ.isError ? (
                <>
                  <p className="admin-job-result">{jobErrorText}</p>
                  <div className="admin-job-row admin-job-row--actions">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void jobConfigQ.refetch()}
                    >
                      Retry
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <div className="admin-job-row admin-job-row--status-line">
                    <span className="admin-stat-label">Status</span>
                    <span
                      className={
                        jobConfigQ.data?.checkUpcomingEnabled
                          ? "admin-job-status admin-job-status--on"
                          : "admin-job-status admin-job-status--off"
                      }
                    >
                      {jobConfigQ.data?.checkUpcomingEnabled ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                  <div className="admin-job-row">
                    <span className="admin-stat-label">Last run</span>
                    <span className="admin-job-value">
                      {formatDateTime(toEpochMs(jobConfigQ.data?.lastRunAt ?? null)) || "N/A"}
                    </span>
                  </div>
                  <div className="admin-job-row">
                    <span className="admin-stat-label">Result</span>
                    <span className="admin-job-value">
                      {formatUpcomingLastRunLine(
                        jobConfigQ.data?.lastRunStatus,
                        jobConfigQ.data?.lastRunMessage
                      )}
                    </span>
                  </div>
                  <p className="admin-job-hint">
                    Run Now walks the whole catalog: it calls the check-upcoming API repeatedly
                    until the sync reports complete, waiting {UPCOMING_ADMIN_BATCH_PAUSE_MS / 1000}s
                    between batches so TMDB is not hammered across serverless invocations.
                  </p>
                  <div className="admin-job-row admin-job-row--actions">
                    <div className="admin-job-actions">
                      <Button
                        type="button"
                        className="admin-job-run-btn"
                        variant="outline"
                        disabled={runNowMutation.isPending || toggleJobMutation.isPending}
                        onClick={() => runNowMutation.mutate()}
                      >
                        {runNowMutation.isPending ? "Running…" : "Run Now"}
                      </Button>
                      {runNowMutation.isPending ? (
                        <Button
                          type="button"
                          variant="outline"
                          disabled={toggleJobMutation.isPending}
                          onClick={() => runUpcomingAbortRef.current?.abort()}
                        >
                          Cancel
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        className="admin-job-toggle-btn"
                        variant="outline"
                        disabled={toggleJobMutation.isPending || runNowMutation.isPending}
                        onClick={() =>
                          toggleJobMutation.mutate(!jobConfigQ.data?.checkUpcomingEnabled)
                        }
                      >
                        {toggleJobMutation.isPending
                          ? "Saving…"
                          : jobConfigQ.data?.checkUpcomingEnabled
                            ? "Disable"
                            : "Enable"}
                      </Button>
                    </div>
                  </div>
                  {runUpcomingProgress ? (
                    <p className="admin-job-result admin-job-result--muted">
                      {runUpcomingProgress}
                    </p>
                  ) : null}
                  {runNowResult ? <p className="admin-job-result">{runNowResult}</p> : null}
                </>
              )}
            </div>
          </div>
          <div className="admin-jobs-deploy-col">
            <h2>GitHub Backup</h2>
            <div className="admin-card admin-job-card">
              {githubBackupQ.isPending ? (
                <p className="admin-job-result">Loading backup workflow status…</p>
              ) : githubBackupQ.isError ? (
                <div className="admin-job-row admin-job-row--actions">
                  <p className="admin-job-result">
                    {githubBackupQ.error instanceof Error
                      ? githubBackupQ.error.message
                      : "Could not load status."}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void githubBackupQ.refetch()}
                  >
                    Retry
                  </Button>
                </div>
              ) : (
                <>
                  {githubBackupQ.data?.githubError ? (
                    <p className="admin-job-result admin-github-backup-warning">
                      {githubBackupQ.data.githubError}
                      {githubBackupQ.data.githubHttpStatus != null
                        ? ` (HTTP ${githubBackupQ.data.githubHttpStatus})`
                        : ""}
                      . For private repos or higher rate limits, set{" "}
                      <code className="admin-deploy-code">GITHUB_TOKEN</code> in Vercel (Actions:
                      read).
                    </p>
                  ) : null}
                  {githubBackupQ.data?.lastRun ? (
                    <>
                      <div className="admin-job-row admin-job-row--status-line">
                        <span className="admin-stat-label">Outcome</span>
                        <span
                          className={
                            githubBackupQ.data.lastRun.conclusion === "success"
                              ? "admin-job-status admin-job-status--on"
                              : githubBackupQ.data.lastRun.conclusion === "failure"
                                ? "admin-job-status admin-job-status--failure"
                                : githubBackupQ.data.lastRun.conclusion
                                  ? "admin-job-status"
                                  : "admin-job-value"
                          }
                        >
                          {githubBackupQ.data.lastRun.conclusion
                            ? githubBackupQ.data.lastRun.conclusion.toUpperCase()
                            : "—"}
                        </span>
                      </div>
                      <div className="admin-job-row">
                        <span className="admin-stat-label">Last run</span>
                        <span className="admin-job-value">
                          {formatDateTime(toEpochMs(githubBackupQ.data.lastRun.updated_at)) || "—"}
                        </span>
                      </div>
                      <div className="admin-job-row">
                        <span className="admin-stat-label">Run status</span>
                        <span className="admin-job-value">
                          {formatGithubRunStatus(githubBackupQ.data.lastRun.status)}
                        </span>
                      </div>
                      <div className="admin-job-row">
                        <span className="admin-stat-label">Trigger</span>
                        <span className="admin-job-value">
                          {formatGithubEvent(githubBackupQ.data.lastRun.event)}
                        </span>
                      </div>
                    </>
                  ) : !githubBackupQ.data?.githubError ? (
                    <p className="admin-job-result">No runs recorded yet for this workflow.</p>
                  ) : null}
                  {!jobConfigQ.isError ? (
                    <div className="admin-job-row admin-job-row--status-line">
                      <span className="admin-stat-label">BACKUP</span>
                      {jobConfigQ.isPending ? (
                        <span className="admin-job-value">Loading…</span>
                      ) : (
                        <span
                          className={
                            jobConfigQ.data?.githubBackupEnabled
                              ? "admin-job-status admin-job-status--on"
                              : "admin-job-status admin-job-status--off"
                          }
                        >
                          {jobConfigQ.data?.githubBackupEnabled ? "Enabled" : "Disabled"}
                        </span>
                      )}
                    </div>
                  ) : null}
                  <div className="admin-job-row admin-job-row--actions">
                    <div className="admin-job-actions">
                      {githubBackupQ.data?.lastRun ? (
                        <Button
                          type="button"
                          className="admin-job-run-btn"
                          variant="outline"
                          asChild
                        >
                          <a
                            href={githubBackupQ.data.lastRun.html_url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Open run
                            <span aria-hidden="true"> ↗</span>
                          </a>
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="outline"
                        className="admin-job-toggle-btn"
                        asChild
                      >
                        <a
                          href={
                            githubBackupQ.data?.actionsUrl ||
                            "https://github.com/maulbogat/watchlist-app/actions/workflows/backup.yml"
                          }
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Workflow & history
                          <span aria-hidden="true"> ↗</span>
                        </a>
                      </Button>
                      {!jobConfigQ.isError ? (
                        <Button
                          type="button"
                          className="admin-job-toggle-btn"
                          variant="outline"
                          disabled={jobConfigQ.isPending || toggleGithubBackupMutation.isPending}
                          onClick={() =>
                            toggleGithubBackupMutation.mutate(!jobConfigQ.data?.githubBackupEnabled)
                          }
                        >
                          {toggleGithubBackupMutation.isPending
                            ? "Saving…"
                            : jobConfigQ.data?.githubBackupEnabled
                              ? "Disable"
                              : "Enable"}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  {jobConfigQ.isError ? (
                    <>
                      <p className="admin-job-result">{jobErrorText}</p>
                      <div className="admin-job-row admin-job-row--actions">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => void jobConfigQ.refetch()}
                        >
                          Retry job config
                        </Button>
                      </div>
                    </>
                  ) : null}
                </>
              )}
            </div>
          </div>
          <div className="admin-jobs-deploy-col">
            <h2>GCS Backup</h2>
            <div className="admin-card admin-job-card">
              {gcsBackupQ.isPending ? (
                <p className="admin-job-result">Loading export folder status…</p>
              ) : gcsBackupQ.isError ? (
                <div className="admin-job-row admin-job-row--actions">
                  <p className="admin-job-result">
                    {gcsBackupQ.error instanceof Error
                      ? gcsBackupQ.error.message
                      : "Could not load status."}
                  </p>
                  <Button type="button" variant="outline" onClick={() => void gcsBackupQ.refetch()}>
                    Retry
                  </Button>
                </div>
              ) : (
                <>
                  <div className="admin-job-row admin-job-row--status-line">
                    <span className="admin-stat-label">Status</span>
                    <span className={gcsBackupStatusBadge(gcsBackupQ.data.status).className}>
                      {gcsBackupStatusBadge(gcsBackupQ.data.status).label}
                    </span>
                  </div>
                  <div className="admin-job-row">
                    <span className="admin-stat-label">Last export</span>
                    <span className="admin-job-value">
                      {formatDateTime(toEpochMs(gcsBackupQ.data.lastExportAt)) ||
                        gcsBackupQ.data.lastExportAt}
                    </span>
                  </div>
                  <div className="admin-job-row admin-job-row--align-start">
                    <span className="admin-stat-label">Folder</span>
                    <span className="admin-job-value admin-job-value--mono-wrap">
                      {gcsBackupQ.data.folderName.trim() ? gcsBackupQ.data.folderName : "—"}
                    </span>
                  </div>
                  <div className="admin-job-row admin-job-row--actions">
                    <div className="admin-job-actions">
                      <Button type="button" variant="outline" className="admin-job-run-btn" asChild>
                        <a href={GCS_BACKUP_CONSOLE_URL} target="_blank" rel="noopener noreferrer">
                          Open bucket
                          <span aria-hidden="true"> ↗</span>
                        </a>
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="admin-job-toggle-btn"
                        disabled={gcsBackupQ.isFetching}
                        onClick={() => void gcsBackupQ.refetch()}
                      >
                        {gcsBackupQ.isFetching ? (
                          <>
                            <Loader2 className="size-4 animate-spin" aria-hidden />
                            Refreshing…
                          </>
                        ) : (
                          "Refresh"
                        )}
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
          <div className="admin-jobs-deploy-col">
            <h2>SENTRY — LAST 24H</h2>
            {sentryIssuesQ.isPending ? (
              <div className="admin-card admin-job-card admin-skeleton" aria-hidden />
            ) : (
              <div className="admin-card admin-job-card">
                {sentryIssuesQ.isError ? (
                  <div className="admin-job-row admin-job-row--actions">
                    <p className="admin-job-result">
                      {sentryIssuesQ.error instanceof Error
                        ? sentryIssuesQ.error.message
                        : "Could not load Sentry status."}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void sentryIssuesQ.refetch()}
                    >
                      Retry
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="admin-job-row admin-job-row--status-line">
                      <span className="admin-stat-label">Open issues</span>
                      {sentryIssuesQ.data.errorCount === 0 ? (
                        <span
                          className="admin-job-status admin-job-status--on"
                          aria-label="No errors"
                        >
                          ✓
                        </span>
                      ) : (
                        <span className="admin-job-status admin-job-status--failure">
                          {sentryIssuesQ.data.errorCount.toLocaleString()}
                        </span>
                      )}
                    </div>
                    <p className="admin-job-result">
                      Unresolved issues with events in the last 24h (up to 100 from the API).
                    </p>
                    <div className="admin-job-row admin-job-row--actions">
                      <div className="admin-job-actions">
                        <Button
                          type="button"
                          variant="outline"
                          className="admin-job-run-btn"
                          asChild
                        >
                          <a href={SENTRY_ISSUES_HUB_URL} target="_blank" rel="noopener noreferrer">
                            Open Sentry
                            <span aria-hidden="true"> ↗</span>
                          </a>
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          className="admin-job-toggle-btn"
                          disabled={sentryIssuesQ.isFetching}
                          onClick={() => void sentryIssuesQ.refetch()}
                        >
                          {sentryIssuesQ.isFetching ? (
                            <>
                              <Loader2 className="size-4 animate-spin" aria-hidden />
                              Refreshing…
                            </>
                          ) : (
                            "Refresh"
                          )}
                        </Button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
          <div className="admin-jobs-deploy-col">
            <h2>Deployments</h2>
            <div className="admin-card admin-job-card">
              {vercelDeploymentQ.isPending ? (
                <p className="admin-job-result">Loading deployment status…</p>
              ) : vercelDeploymentQ.isError ? (
                <div className="admin-job-row admin-job-row--actions">
                  <p className="admin-job-result">
                    {vercelDeploymentQ.error instanceof Error
                      ? vercelDeploymentQ.error.message
                      : "Could not load status."}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void vercelDeploymentQ.refetch()}
                  >
                    Retry
                  </Button>
                </div>
              ) : (
                <>
                  {vercelDeploymentQ.data?.vercelError ? (
                    <p className="admin-job-result admin-github-backup-warning">
                      {vercelDeploymentQ.data.vercelError}
                      {vercelDeploymentQ.data.vercelHttpStatus != null
                        ? ` (HTTP ${vercelDeploymentQ.data.vercelHttpStatus})`
                        : ""}
                      . Check <code className="admin-deploy-code">VERCEL_API_TOKEN</code> and{" "}
                      <code className="admin-deploy-code">VERCEL_PROJECT_ID</code> in Vercel env.
                    </p>
                  ) : null}
                  {vercelDeploymentQ.data?.lastDeployment ? (
                    <AdminVercelDeploymentSummary dep={vercelDeploymentQ.data.lastDeployment} />
                  ) : !vercelDeploymentQ.data?.vercelError ? (
                    <p className="admin-job-result">
                      No deployments returned for this project yet.
                    </p>
                  ) : null}
                  <div className="admin-job-row admin-job-row--actions">
                    <div className="admin-job-actions">
                      <Button
                        type="button"
                        variant="outline"
                        className="admin-job-toggle-btn"
                        asChild
                      >
                        <a href={deploymentsUrl} target="_blank" rel="noopener noreferrer">
                          Open deployments
                          <span aria-hidden="true"> ↗</span>
                        </a>
                      </Button>
                    </div>
                  </div>
                  {!hasCustomDeploymentsUrl ? (
                    <p className="admin-job-result">
                      Optional: set <code className="admin-deploy-code">VITE_DEPLOYMENTS_URL</code>{" "}
                      for a custom deployments page link.
                    </p>
                  ) : null}
                </>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="admin-section">
        <div className="admin-dq-heading-row">
          <h2>ACTIVITY (LAST 24H)</h2>
          <div className="admin-dq-refresh">
            <Button type="button" variant="ghost" className="admin-dq-external-link" asChild>
              <a href={AXIOM_ACTIVITY_DASHBOARD_URL} target="_blank" rel="noopener noreferrer">
                Axiom dashboard
                <span aria-hidden="true"> ↗</span>
              </a>
            </Button>
            <Button
              type="button"
              variant="outline"
              className="admin-job-toggle-btn"
              disabled={axiomActivityQ.isPending || axiomActivityQ.isFetching}
              onClick={() => void axiomActivityQ.refetch()}
            >
              {axiomActivityQ.isFetching ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  Refreshing…
                </>
              ) : (
                "Refresh"
              )}
            </Button>
          </div>
        </div>
        <div className="admin-grid admin-grid--stats">
          {axiomActivityQ.isPending ? (
            Array.from({ length: ACTIVITY_STAT_CARD_COUNT }).map((_, idx) => (
              <div
                key={`axiom-activity-skeleton-${idx}`}
                className="admin-card admin-stat-card admin-skeleton"
              />
            ))
          ) : axiomActivityQ.isError ? (
            <div className="admin-card admin-job-card">
              <p className="admin-job-result" role="alert">
                {axiomActivityQ.error instanceof Error
                  ? axiomActivityQ.error.message
                  : "Could not load Axiom activity."}
              </p>
              <div className="admin-job-row admin-job-row--actions">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void axiomActivityQ.refetch()}
                >
                  Retry
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="admin-card admin-stat-card">
                <div className="admin-stat-label">API Reads (server)</div>
                <div
                  className={axiomFirestoreReadsValueClass(axiomActivityQ.data.firestoreReads)}
                  title="Green ≤ 40k, gold > 40k, red > 45k (rolling 24h sum of documentCount)"
                >
                  {Math.round(axiomActivityQ.data.firestoreReads).toLocaleString()}
                </div>
              </div>
              <div className="admin-card admin-stat-card">
                <div className="admin-stat-label">User actions</div>
                <div className="admin-stat-value">
                  {Math.round(axiomActivityQ.data.userActions).toLocaleString()}
                </div>
              </div>
              <div className="admin-card admin-stat-card">
                <div className="admin-stat-label">Titles added</div>
                <div className="admin-stat-value">
                  {Math.round(axiomActivityQ.data.titlesAdded).toLocaleString()}
                </div>
              </div>
              <div className="admin-card admin-stat-card">
                <div className="admin-stat-label">Errors</div>
                <AxiomActivityErrorsStat count={axiomActivityQ.data.errors} />
              </div>
            </>
          )}
        </div>
      </section>

      <section className="admin-section">
        <div className="admin-dq-heading-row">
          <h2>Firestore Usage</h2>
          <div className="admin-dq-refresh">
            <Button type="button" variant="ghost" className="admin-dq-external-link" asChild>
              <a
                href={FIREBASE_FIRESTORE_USAGE_CONSOLE_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                Firebase usage
                <span aria-hidden="true"> ↗</span>
              </a>
            </Button>
          </div>
        </div>
        <p
          style={{
            color: "var(--color-muted, var(--muted))",
            fontSize: "var(--text-xs)",
            margin: "0 0 0.65rem",
            letterSpacing: "0.04em",
            lineHeight: 1.35,
          }}
        >
          Counts reads through kill switch guard only — not all reads.
        </p>
        <div className="admin-grid admin-grid--stats admin-grid--usage">
          {firestoreUsageQ.isPending ? (
            <div className="admin-card admin-job-card admin-skeleton" />
          ) : firestoreUsageQ.isError ? (
            <div className="admin-card admin-job-card">
              <p className="admin-job-result" role="alert">
                {firestoreUsageQ.error instanceof Error
                  ? firestoreUsageQ.error.message
                  : "Could not load usage stats."}
              </p>
              <div className="admin-job-row admin-job-row--actions">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void firestoreUsageQ.refetch()}
                >
                  Retry
                </Button>
              </div>
            </div>
          ) : (
            <div className="admin-card admin-job-card admin-usage-card">
              {!firestoreUsageQ.data ? (
                <p className="admin-job-result">No usage data yet (quota doc not created).</p>
              ) : (
                <>
                  <div className="admin-usage-metric">
                    <div className="admin-usage-metric-head">
                      <span className="admin-stat-label">Reads this hour</span>
                      <span className="admin-usage-metric-fraction">
                        {Math.round(firestoreUsageQ.data.readsThisHour).toLocaleString()} /{" "}
                        {FIRESTORE_USAGE_HOURLY_LIMIT.toLocaleString()}
                      </span>
                    </div>
                    <div className="admin-usage-bar-wrap" aria-hidden="true">
                      <div
                        className="admin-usage-bar-fill"
                        style={{
                          width: `${usagePercent(firestoreUsageQ.data.readsThisHour, FIRESTORE_USAGE_HOURLY_LIMIT)}%`,
                          backgroundColor: usageBarColor(
                            usagePercent(
                              firestoreUsageQ.data.readsThisHour,
                              FIRESTORE_USAGE_HOURLY_LIMIT
                            )
                          ),
                        }}
                      />
                    </div>
                  </div>
                  <div className="admin-usage-metric">
                    <div className="admin-usage-metric-head">
                      <span className="admin-stat-label">Reads today</span>
                      <span className="admin-usage-metric-fraction">
                        {Math.round(firestoreUsageQ.data.readsToday).toLocaleString()} /{" "}
                        {FIRESTORE_USAGE_DAILY_LIMIT.toLocaleString()}
                      </span>
                    </div>
                    <div className="admin-usage-bar-wrap" aria-hidden="true">
                      <div
                        className="admin-usage-bar-fill"
                        style={{
                          width: `${usagePercent(firestoreUsageQ.data.readsToday, FIRESTORE_USAGE_DAILY_LIMIT)}%`,
                          backgroundColor: usageBarColor(
                            usagePercent(
                              firestoreUsageQ.data.readsToday,
                              FIRESTORE_USAGE_DAILY_LIMIT
                            )
                          ),
                        }}
                      />
                    </div>
                  </div>
                  <div className="admin-job-row">
                    <span className="admin-stat-label">Last reset</span>
                    <span className="admin-job-value">
                      {formatUsageUpdatedAt(firestoreUsageQ.data)}
                    </span>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </section>

      <section className="admin-section">
        <div className="admin-dq-heading-row">
          <h2>Data Quality</h2>
          <div className="admin-dq-refresh">
            <Button
              type="button"
              variant="outline"
              disabled={catalogStatsQ.isPending || catalogStatsQ.isFetching}
              onClick={() => {
                void catalogStatsQ.refetch();
              }}
            >
              {catalogStatsQ.isFetching ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  Refreshing…
                </>
              ) : (
                "Refresh"
              )}
            </Button>
          </div>
        </div>
        <div className="admin-grid admin-grid--stats admin-grid--dq-stats-row">
          {catalogStatsQ.isPending
            ? Array.from({ length: DQ_STAT_CARD_COUNT }).map((_, idx) => (
                <div
                  key={`catalog-skeleton-${idx}`}
                  className="admin-card admin-stat-card admin-skeleton"
                />
              ))
            : dqStatCards?.map((c) => (
                <div key={c.label} className="admin-card admin-stat-card">
                  <div className="admin-stat-label">{c.label}</div>
                  <AdminDqStatValue count={c.count} tone={c.tone} />
                </div>
              ))}
        </div>

        {dqGridItems.length > 0 ? (
          <div className="admin-dq-details admin-dq-details--grid">
            {dqGridItems.map((item) => {
              if (item.kind === "panel") {
                const panelCount = item.def.count;
                const panelExpandable = typeof panelCount === "number" && panelCount > 0;
                const panelBodyOpen = panelExpandable
                  ? dqPanelsOpen[item.def.key]
                  : item.def.rows.length > 0;
                return (
                  <div key={item.def.key} className="admin-dq-detail">
                    {panelExpandable ? (
                      <button
                        type="button"
                        className="admin-dq-detail-toggle"
                        aria-expanded={dqPanelsOpen[item.def.key]}
                        onClick={() =>
                          setDqPanelsOpen((prev) => ({
                            ...prev,
                            [item.def.key]: !prev[item.def.key],
                          }))
                        }
                      >
                        <span className="admin-dq-detail-toggle-label">
                          {item.def.count} titles missing {item.def.fieldLabel}
                        </span>
                        <span className="admin-dq-chevron">
                          {dqPanelsOpen[item.def.key] ? "▴ Hide" : "▾ Show"}
                        </span>
                      </button>
                    ) : (
                      <div className="admin-dq-detail-toggle--static" role="status">
                        <span className="admin-dq-detail-toggle-label">
                          {item.def.count} titles missing {item.def.fieldLabel}
                        </span>
                      </div>
                    )}
                    {panelBodyOpen ? (
                      <div className="admin-dq-detail-body">
                        {item.def.rows.map((row) => (
                          <div key={row.imdbId} className="admin-dq-li">
                            <span className="admin-dq-li-text">
                              {row.imdbId} · {row.title} ({formatDqYear(row.year)})
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              }
              if (hasCatalogOrphansScanResult && catalogOrphansData) {
                const orphanCount = catalogOrphansData.count;
                const orphanExpandable = orphanCount > 0;
                const orphanBodyOpen = orphanExpandable
                  ? dqPanelsOpen.orphans
                  : catalogOrphansData.orphans.length > 0;
                return (
                  <div key="orphans" className="admin-dq-detail">
                    <div
                      className="admin-dq-orphan-scan-row"
                      role="status"
                      aria-busy={orphanScanBusy}
                      aria-live="polite"
                    >
                      <span className="admin-dq-detail-toggle-label">
                        {catalogOrphansData.count} titles not on any list
                      </span>
                      <div className="admin-dq-orphan-scan-row-actions">
                        {orphanScanBusy ? (
                          <Loader2
                            className="admin-dq-orphan-scan-spinner"
                            aria-label="Scan in progress"
                          />
                        ) : (
                          <button
                            type="button"
                            className="btn-secondary admin-dq-orphan-scan-btn"
                            onClick={() => void runCatalogOrphansScan()}
                          >
                            Scan now
                          </button>
                        )}
                        {orphanExpandable ? (
                          <button
                            type="button"
                            className="admin-dq-orphan-show-toggle"
                            aria-expanded={dqPanelsOpen.orphans}
                            onClick={() =>
                              setDqPanelsOpen((prev) => ({ ...prev, orphans: !prev.orphans }))
                            }
                          >
                            <span className="admin-dq-chevron">
                              {dqPanelsOpen.orphans ? "▴ Hide" : "▾ Show"}
                            </span>
                          </button>
                        ) : null}
                      </div>
                    </div>
                    {orphanScanError ? (
                      <p className="admin-dq-orphan-scan-error" role="alert">
                        {orphanScanError}
                      </p>
                    ) : null}
                    {orphanBodyOpen ? (
                      <div className="admin-dq-detail-body admin-orphan-detail-body">
                        {catalogOrphansData.truncated ? (
                          <p className="admin-subtitle admin-orphan-truncated">
                            Showing first {catalogOrphansData.orphans.length} of{" "}
                            {catalogOrphansData.count}
                            {catalogOrphansData.omitted > 0
                              ? ` (${catalogOrphansData.omitted} omitted in this response)`
                              : ""}
                            . For the full list, run{" "}
                            <code className="admin-dq-code">
                              node scripts/catalog-not-on-any-list.mjs
                            </code>
                            .
                          </p>
                        ) : null}
                        {catalogOrphansData.orphans.map((row) => {
                          const isRowDeleting = orphanDeleteInFlightIds.has(row.registryId);
                          const isRowExiting = orphanExitingIds.includes(row.registryId);
                          return (
                            <div
                              key={row.registryId}
                              className={cn(
                                "admin-dq-li",
                                "admin-dq-li--orphan",
                                isRowDeleting && "admin-dq-li--orphan-deleting",
                                isRowExiting && "admin-dq-li--orphan-exiting"
                              )}
                            >
                              <span className="admin-dq-li-text">
                                {row.registryId} · {row.title} ({formatDqYear(row.year)})
                              </span>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className={cn(
                                  "admin-dq-orphan-delete",
                                  isRowDeleting && "admin-dq-orphan-delete--busy"
                                )}
                                disabled={isRowDeleting || isRowExiting}
                                aria-label={`Remove ${row.title} from catalog`}
                                title="Remove from catalog"
                                onClick={() => deleteRegistryOrphanM.mutate(row.registryId)}
                              >
                                {isRowDeleting ? (
                                  <Loader2
                                    className="size-4 admin-dq-orphan-delete__spinner"
                                    aria-hidden
                                  />
                                ) : (
                                  <Trash2 className="size-4" aria-hidden />
                                )}
                              </Button>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                );
              }
              return (
                <div key="orphans" className="admin-dq-detail admin-dq-detail--orphan-pending">
                  <div
                    className="admin-dq-orphan-scan-row"
                    role="status"
                    aria-busy={orphanScanBusy}
                    aria-live="polite"
                  >
                    <span className="admin-dq-detail-toggle-label">titles not on any list</span>
                    {orphanScanBusy ? (
                      <Loader2
                        className="admin-dq-orphan-scan-spinner"
                        aria-label="Scan in progress"
                      />
                    ) : (
                      <button
                        type="button"
                        className="btn-secondary admin-dq-orphan-scan-btn"
                        onClick={() => void runCatalogOrphansScan()}
                      >
                        Scan now
                      </button>
                    )}
                  </div>
                  {orphanScanError ? (
                    <p className="admin-dq-orphan-scan-error" role="alert">
                      {orphanScanError}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </section>

      <RecommendationSettingsSection />

      <section className="admin-section">
        <h2>Service Links</h2>
        <div className="admin-grid admin-grid--links">
          {SERVICE_LINKS.map((entry) =>
            "url" in entry ? (
              <a
                key={entry.url}
                className="admin-card admin-link-card"
                href={entry.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                <span className="admin-link-label">{entry.label}</span>
                <span className="admin-link-sublabel">{entry.sublabel}</span>
                <span className="admin-link-ext" aria-hidden="true">
                  ↗
                </span>
              </a>
            ) : (
              <div
                key={entry.links[0]?.url ?? entry.label}
                className="admin-card admin-link-card admin-link-card--multi"
              >
                <span className="admin-link-label">{entry.label}</span>
                <span className="admin-link-sublabel">{entry.sublabel}</span>
                <ul className="admin-link-multi-list">
                  {entry.links.map((row) => (
                    <li key={row.url}>
                      <a
                        className="admin-link-multi-anchor"
                        href={row.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {row.label}
                        <span aria-hidden="true"> ↗</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )
          )}
        </div>
      </section>

      <footer className="admin-footer">
        <Button
          type="button"
          variant="outline"
          className="admin-back-btn"
          onClick={() => navigate("/")}
        >
          ← Back to Watchlist
        </Button>
      </footer>
    </main>
  );
}
