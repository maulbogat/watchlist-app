import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppStore } from "../store/useAppStore.js";
import { isAdmin } from "../config/admin.js";
import { useAuthUser } from "../hooks/useAuthUser.js";
import {
  auth,
  getFirestoreUsageStats,
  getJobConfigState,
  setCheckUpcomingEnabledState,
  type FirestoreUsageStats,
} from "../firebase.js";
import { getFirestore, collection, getCountFromServer, getDocs } from "firebase/firestore";

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

type UpcomingStats = {
  activeAlerts: number;
  lastCheckTimestamp: string | null;
};

type JobConfigState = {
  checkUpcomingEnabled: boolean;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunMessage: string | null;
  lastRunResult: Record<string, unknown> | null;
};

type RunNowResponse = {
  ok?: boolean;
  skipped?: boolean;
  reason?: string;
  alertsUpserted?: number;
  writesSkipped?: number;
  error?: string;
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

/** Production site origin (bookmarklet / admin links). Override with VITE_APP_ORIGIN when your host differs. */
const DEFAULT_APP_ORIGIN = "https://watchlist-trailers.vercel.app";
const appOrigin = (import.meta.env.VITE_APP_ORIGIN as string | undefined)?.trim() || DEFAULT_APP_ORIGIN;

const SERVICE_LINKS = [
  {
    label: "Watchlist",
    sublabel: "Production site",
    url: `${appOrigin}/`,
  },
  {
    label: "Firebase",
    sublabel: "Firestore Data",
    url: "https://console.firebase.google.com/u/0/project/movie-trailer-site/firestore/databases/-default-/data/",
  },
  {
    label: "Vercel",
    sublabel: "env vars",
    url: "https://vercel.com/maulbogats-projects/movie-trailer-site/settings/environment-variables",
  },
  {
    label: "Vercel",
    sublabel: "Function logs",
    url: "https://vercel.com/maulbogats-projects/movie-trailer-site/logs",
  },
  {
    label: "Resend",
    sublabel: "Emails",
    url: "https://resend.com/emails",
  },
  {
    label: "Meta",
    sublabel: "WhatsApp API",
    url: "https://developers.facebook.com/apps/1104781941831455/use_cases/customize/wa-settings/?use_case_enum=WHATSAPP_BUSINESS_MESSAGING&product_route=whatsapp-business&business_id=762125852300048&selected_tab=wa-dev-console",
  },
  {
    label: "Meta Business",
    sublabel: "System users",
    url: "https://business.facebook.com/latest/settings/system_users?business_id=762125852300048&selected_user_id=61576462286852",
  },
  {
    label: "Google Cloud",
    sublabel: "Billing",
    url: "https://console.cloud.google.com/billing/0145FD-CB6342-6B19AD",
  },
  {
    label: "Cloudflare",
    sublabel: "Dashboard",
    url: "https://dash.cloudflare.com/a32df282319e2330a05f8a4511017022/home/overview",
  },
  {
    label: "GitHub",
    sublabel: "Project Repository",
    url: "https://github.com/maulbogat/movie-trailer-site",
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
    label: "IMDb",
    sublabel: "Homepage",
    url: "https://www.imdb.com/?ref_=hm_nv_home",
  },
  {
    label: "Notion",
    sublabel: "Project Management",
    url: "https://www.notion.so/1a114e9ce7a34dcab5cae4e52ef180c2?v=787e39f04dba4825932d2c74fd1aebe0",
  },
  {
    label: "Claude",
    sublabel: "Chat Thread",
    url: "https://claude.ai/chat/4e4012e1-2d55-45a2-9eba-0876d2ff2d4d",
  },
  {
    label: "Axiom",
    sublabel: "Logs & Monitoring",
    /* Avoid embedding the real dataset slug — it may match host secret scanners (e.g. AXIOM_DATASET) and fail the build. */
    url: "https://app.axiom.co/",
  },
] as const;

const rawViteDeploymentsUrl = (import.meta.env.VITE_DEPLOYMENTS_URL as string | undefined)?.trim();
const deploymentsUrl =
  rawViteDeploymentsUrl || "https://vercel.com/maulbogats-projects/~/deployments";
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

function formatUpcomingLastRunLine(status: string | null | undefined, message: string | null | undefined): string {
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
  if (percent > 80) return "#e85a5a";
  if (percent >= 50) return "#e8c96a";
  return "#6bcf7f";
}

function formatUsageUpdatedAt(stats: FirestoreUsageStats | null | undefined): string {
  if (!stats?.updatedAt?.trim()) return "N/A";
  const ms = toEpochMs(stats.updatedAt);
  return formatDateTime(ms) || stats.updatedAt;
}

export function AdminPage() {
  const navigate = useNavigate();
  const { loading: authLoading } = useAuthUser();
  const currentUser = useAppStore((s) => s.currentUser);
  const userIsAdmin = isAdmin(currentUser?.uid);

  const catalogStatsQ = useQuery<CatalogStats>({
    queryKey: ["admin", "catalog-stats"],
    staleTime: 60 * 1000,
    enabled: !authLoading && userIsAdmin,
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
            "type",
          ) ?? titleRegistryRef;
        const registrySnap = await getDocs(projectedRegistryRef);
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
            typeof rec.year === "number" || typeof rec.year === "string" ? (rec.year as number | string) : null;

          const noTmdbId = rec.tmdbId == null || rec.tmdbId === "";
          if (noTmdbId) {
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
              const tid = rec.tmdbId;
              const tmdbId =
                typeof tid === "number" && Number.isFinite(tid)
                  ? tid
                  : typeof tid === "string" && tid.trim() !== "" && !Number.isNaN(Number(tid))
                    ? Number(tid)
                    : null;
              missingThumbTitles.push({ imdbId, title, year, tmdbId });
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

  const [dqPanelsOpen, setDqPanelsOpen] = useState<Record<DQDetailKey, boolean>>({
    tmdbId: false,
    thumb: false,
    tmdbMedia: false,
    youtubeId: false,
  });
  const [fixingThumbImdbId, setFixingThumbImdbId] = useState<string | null>(null);

  const fixCatalogThumb = useCallback(
    async (imdbId: string) => {
      const user = auth.currentUser;
      if (!user) return;
      setFixingThumbImdbId(imdbId);
      try {
        const idToken = await user.getIdToken();
        const res = await fetch("/api/catalog-health", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${idToken}`,
          },
          body: JSON.stringify({ imdbId }),
        });
        const data = (await res.json()) as { ok?: boolean; error?: string; thumb?: string };
        if (!res.ok || data.ok === false) {
          throw new Error(data.error || `Request failed (${res.status})`);
        }
        await catalogStatsQ.refetch();
      } catch (e) {
        console.error("Catalog thumb fix failed:", e);
      } finally {
        setFixingThumbImdbId(null);
      }
    },
    [catalogStatsQ],
  );

  const firestoreUsageQ = useQuery<FirestoreUsageStats | null>({
    queryKey: ["admin", "firestore-usage-stats"],
    staleTime: 0,
    refetchOnMount: "always",
    enabled: !authLoading && userIsAdmin,
    queryFn: getFirestoreUsageStats,
  });

  const upcomingStatsQ = useQuery<UpcomingStats>({
    queryKey: ["admin", "upcoming-stats"],
    staleTime: 60 * 1000,
    enabled: !authLoading && userIsAdmin,
    queryFn: async () => {
      const db = getFirestore();
      const upcomingRef = collection(db, "upcomingAlerts");
      const projectedUpcomingRef =
        (upcomingRef as MaybeSelectable<typeof upcomingRef>).select?.("expiresAt", "detectedAt") ?? upcomingRef;
      const snap = await getDocs(projectedUpcomingRef);
      const now = Date.now();
      let activeAlerts = 0;
      let latestDetectedAt: number | null = null;

      snap.forEach((d) => {
        const row = d.data() as Record<string, unknown>;
        const expiresAtMs = toEpochMs(row.expiresAt);
        if (expiresAtMs != null && expiresAtMs > now) activeAlerts += 1;

        const detectedAtMs = toEpochMs(row.detectedAt);
        if (detectedAtMs != null && (latestDetectedAt == null || detectedAtMs > latestDetectedAt)) {
          latestDetectedAt = detectedAtMs;
        }
      });

      return {
        activeAlerts,
        lastCheckTimestamp: formatDateTime(latestDetectedAt),
      };
    },
  });

  const jobConfigQ = useQuery<JobConfigState>({
    queryKey: ["admin", "job-config"],
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    enabled: !authLoading && userIsAdmin,
    queryFn: () => getJobConfigState(),
  });

  const githubBackupQ = useQuery<GithubBackupStatusResponse>({
    queryKey: ["admin", "external-status", "github"],
    staleTime: 60 * 1000,
    enabled: !authLoading && userIsAdmin,
    queryFn: async () => {
      const user = auth.currentUser;
      if (!user) throw new Error("Not signed in");
      const idToken = await user.getIdToken();
      const res = await fetch("/api/external-status?service=github", {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      const data = (await res.json()) as GithubBackupStatusResponse & { error?: string };
      if (!res.ok) {
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      if (data.ok === false && data.error) {
        throw new Error(data.error);
      }
      return data;
    },
  });

  const vercelDeploymentQ = useQuery<VercelDeploymentStatusResponse>({
    queryKey: ["admin", "external-status", "vercel"],
    staleTime: 0,
    refetchOnMount: "always",
    enabled: !authLoading && userIsAdmin,
    queryFn: async () => {
      const user = auth.currentUser;
      if (!user) throw new Error("Not signed in");
      const idToken = await user.getIdToken();
      const res = await fetch("/api/external-status?service=vercel", {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      const data = (await res.json()) as VercelDeploymentStatusResponse & { error?: string };
      if (!res.ok) {
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      if (data.ok === false && data.error) {
        throw new Error(data.error);
      }
      return data;
    },
  });

  const [runNowResult, setRunNowResult] = useState<string | null>(null);
  const runNowTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (runNowTimerRef.current) window.clearTimeout(runNowTimerRef.current);
    };
  }, []);

  function showRunNowResult(message: string) {
    setRunNowResult(message);
    if (runNowTimerRef.current) window.clearTimeout(runNowTimerRef.current);
    runNowTimerRef.current = window.setTimeout(() => {
      setRunNowResult(null);
      runNowTimerRef.current = null;
    }, 10_000);
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

  const runNowMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/check-upcoming", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trigger: "manual" }),
      });
      const raw = await res.text();
      let data: RunNowResponse = {};
      let textFallback = "";
      try {
        data = raw ? (JSON.parse(raw) as RunNowResponse) : {};
      } catch {
        textFallback = raw;
      }
      if (!res.ok || data.ok === false) {
        throw new Error(textFallback || data.error || `Request failed (${res.status})`);
      }
      if (textFallback) {
        return { ok: true, reason: textFallback };
      }
      return data;
    },
    onSuccess: (data) => {
      if (data.skipped) {
        showRunNowResult(data.reason || "Skipped");
      } else {
        if (typeof data.reason === "string" && data.reason.trim()) {
          showRunNowResult(data.reason);
          void jobConfigQ.refetch();
          return;
        }
        const written = typeof data.alertsUpserted === "number" ? data.alertsUpserted : null;
        const skipped = typeof data.writesSkipped === "number" ? data.writesSkipped : null;
        if (written != null || skipped != null) {
          showRunNowResult(`Done — wrote ${written ?? 0}, skipped ${skipped ?? 0}`);
        } else {
          showRunNowResult("Done");
        }
      }
      void jobConfigQ.refetch();
    },
    onError: (err: Error) => {
      showRunNowResult(err.message || "Failed to run check-upcoming");
      void jobConfigQ.refetch();
    },
  });

  const jobErrorText = (() => {
    if (!jobConfigQ.isError) return null;
    const err = jobConfigQ.error;
    if (err instanceof Error && err.message) return err.message;
    return "Could not load job config.";
  })();

  if (authLoading) {
    return <div className="react-migration-shell">Loading…</div>;
  }

  if (!userIsAdmin) {
    return <Navigate to="/" replace />;
  }

  return (
    <main className="admin-page">
      <header className="admin-header">
        <h1>Admin</h1>
        <p className="admin-subtitle">{currentUser?.email || "Unknown email"}</p>
      </header>

      <section className="admin-section">
        <h2>Service Links</h2>
        <div className="admin-grid admin-grid--links">
          {SERVICE_LINKS.map((link) => (
            <a
              key={link.url}
              className="admin-card admin-link-card"
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              <span className="admin-link-label">{link.label}</span>
              <span className="admin-link-sublabel">{link.sublabel}</span>
              <span className="admin-link-ext" aria-hidden="true">
                ↗
              </span>
            </a>
          ))}
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
              onClick={() => void catalogStatsQ.refetch()}
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
        <div className="admin-grid admin-grid--stats">
          {catalogStatsQ.isPending
            ? Array.from({ length: 5 }).map((_, idx) => (
                <div key={`catalog-skeleton-${idx}`} className="admin-card admin-stat-card admin-skeleton" />
              ))
            : (() => {
                const d = catalogStatsQ.data;
                const cards: {
                  label: string;
                  count: number | "Error";
                  tone: "critical" | "warn" | "neutral";
                }[] = [
                  { label: "Total titles in catalog", count: d?.totalTitles ?? "Error", tone: "neutral" },
                  { label: "Missing tmdbId", count: d?.missingTmdbId ?? "Error", tone: "critical" },
                  { label: "Missing thumb", count: d?.missingThumb ?? "Error", tone: "warn" },
                  { label: "Missing tmdbMedia", count: d?.missingTmdbMedia ?? "Error", tone: "warn" },
                  { label: "Missing youtubeId", count: d?.missingYoutubeId ?? "Error", tone: "warn" },
                ];
                return cards.map((c) => (
                  <div key={c.label} className="admin-card admin-stat-card">
                    <div className="admin-stat-label">{c.label}</div>
                    <AdminDqStatValue count={c.count} tone={c.tone} />
                  </div>
                ));
              })()}
        </div>

        {!catalogStatsQ.isPending && catalogStatsQ.data
          ? (() => {
              const d = catalogStatsQ.data;
              const panels: {
                key: DQDetailKey;
                fieldLabel: string;
                count: number | "Error";
                rows: DQTitleRow[] | DQThumbRow[];
                fixable?: boolean;
              }[] = [
                {
                  key: "tmdbId",
                  fieldLabel: "tmdbId",
                  count: d.missingTmdbId,
                  rows: d.missingTmdbIdTitles,
                },
                {
                  key: "thumb",
                  fieldLabel: "thumb",
                  count: d.missingThumb,
                  rows: d.missingThumbTitles,
                  fixable: true,
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

              const visible = panels.filter((p) => typeof p.count === "number" && p.count > 0);
              if (visible.length === 0) return null;

              return (
                <div className="admin-dq-details">
                  {visible.map((p) => {
                    const open = dqPanelsOpen[p.key];
                    return (
                      <div key={p.key} className="admin-dq-detail">
                        <button
                          type="button"
                          className="admin-dq-detail-toggle"
                          aria-expanded={open}
                          onClick={() =>
                            setDqPanelsOpen((prev) => ({ ...prev, [p.key]: !prev[p.key] }))
                          }
                        >
                          <span className="admin-dq-detail-toggle-label">
                            {p.count} titles missing {p.fieldLabel}
                          </span>
                          <span className="admin-dq-chevron">{open ? "▴ Hide" : "▾ Show"}</span>
                        </button>
                        {open ? (
                          <div className="admin-dq-detail-body">
                            {p.rows.map((row) => (
                              <div key={row.imdbId} className="admin-dq-li">
                                <span className="admin-dq-li-text">
                                  {row.imdbId} · {row.title} ({formatDqYear(row.year)})
                                </span>
                                {p.fixable && "tmdbId" in row ? (
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="admin-dq-fix-btn"
                                    disabled={
                                      fixingThumbImdbId === row.imdbId ||
                                      row.tmdbId == null ||
                                      catalogStatsQ.isFetching
                                    }
                                    title={
                                      row.tmdbId == null
                                        ? "Needs tmdbId on document before TMDB poster fetch"
                                        : undefined
                                    }
                                    onClick={() => void fixCatalogThumb(row.imdbId)}
                                  >
                                    {fixingThumbImdbId === row.imdbId ? (
                                      <>
                                        <Loader2 className="size-3.5 animate-spin" aria-hidden />
                                        Fix…
                                      </>
                                    ) : (
                                      "Fix"
                                    )}
                                  </Button>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              );
            })()
          : null}
      </section>

      <section className="admin-section">
        <h2>Firestore Usage</h2>
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
                <Button type="button" variant="outline" onClick={() => void firestoreUsageQ.refetch()}>
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
                            usagePercent(firestoreUsageQ.data.readsThisHour, FIRESTORE_USAGE_HOURLY_LIMIT)
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
                            usagePercent(firestoreUsageQ.data.readsToday, FIRESTORE_USAGE_DAILY_LIMIT)
                          ),
                        }}
                      />
                    </div>
                  </div>
                  <div className="admin-job-row">
                    <span className="admin-stat-label">Last reset</span>
                    <span className="admin-job-value">{formatUsageUpdatedAt(firestoreUsageQ.data)}</span>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </section>

      <section className="admin-section">
        <h2>Upcoming Alerts Stats</h2>
        <div className="admin-grid admin-grid--stats">
          {upcomingStatsQ.isPending ? (
            <>
              <div className="admin-card admin-stat-card admin-skeleton" />
              <div className="admin-card admin-stat-card admin-skeleton" />
            </>
          ) : (
            <>
              <div className="admin-card admin-stat-card">
                <div className="admin-stat-label">Total active alerts</div>
                <div className="admin-stat-value">
                  {upcomingStatsQ.isError ? "Error" : String(upcomingStatsQ.data?.activeAlerts ?? 0)}
                </div>
              </div>
              <div className="admin-card admin-stat-card">
                <div className="admin-stat-label">Last check timestamp</div>
                <div className="admin-stat-value admin-stat-value--small">
                  {upcomingStatsQ.isError ? "Error" : upcomingStatsQ.data?.lastCheckTimestamp || "N/A"}
                </div>
              </div>
            </>
          )}
        </div>
      </section>

      <section className="admin-section admin-section--jobs-deploy">
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
                    <Button type="button" variant="outline" onClick={() => void jobConfigQ.refetch()}>
                      Retry
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <div className="admin-job-row admin-job-row--status-line">
                    <span className="admin-stat-label">Upcoming check enabled</span>
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
                      {formatUpcomingLastRunLine(jobConfigQ.data?.lastRunStatus, jobConfigQ.data?.lastRunMessage)}
                    </span>
                  </div>
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
                      <Button
                        type="button"
                        className="admin-job-toggle-btn"
                        variant="outline"
                        disabled={toggleJobMutation.isPending || runNowMutation.isPending}
                        onClick={() => toggleJobMutation.mutate(!jobConfigQ.data?.checkUpcomingEnabled)}
                      >
                        {toggleJobMutation.isPending
                          ? "Saving…"
                          : jobConfigQ.data?.checkUpcomingEnabled
                            ? "Disable"
                            : "Enable"}
                      </Button>
                    </div>
                  </div>
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
                    {githubBackupQ.error instanceof Error ? githubBackupQ.error.message : "Could not load status."}
                  </p>
                  <Button type="button" variant="outline" onClick={() => void githubBackupQ.refetch()}>
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
                      <code className="admin-deploy-code">GITHUB_TOKEN</code> in Vercel (Actions: read).
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
                  <div className="admin-job-row admin-job-row--actions">
                    <div className="admin-job-actions">
                      {githubBackupQ.data?.lastRun ? (
                        <Button type="button" className="admin-job-run-btn" variant="outline" asChild>
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
                      <Button type="button" variant="outline" className="admin-job-toggle-btn" asChild>
                        <a
                          href={
                            githubBackupQ.data?.actionsUrl ||
                            "https://github.com/maulbogat/movie-trailer-site/actions/workflows/backup.yml"
                          }
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Workflow & history
                          <span aria-hidden="true"> ↗</span>
                        </a>
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </div>
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
                  <Button type="button" variant="outline" onClick={() => void vercelDeploymentQ.refetch()}>
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
                  {vercelDeploymentQ.data?.lastDeployment ? (() => {
                    const dep = vercelDeploymentQ.data.lastDeployment;
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
                  })() : !vercelDeploymentQ.data?.vercelError ? (
                    <p className="admin-job-result">No deployments returned for this project yet.</p>
                  ) : null}
                  <div className="admin-job-row admin-job-row--actions">
                    <div className="admin-job-actions">
                      <Button type="button" variant="outline" className="admin-job-toggle-btn" asChild>
                        <a href={deploymentsUrl} target="_blank" rel="noopener noreferrer">
                          Open deployments
                          <span aria-hidden="true"> ↗</span>
                        </a>
                      </Button>
                    </div>
                  </div>
                  {!hasCustomDeploymentsUrl ? (
                    <p className="admin-job-result">
                      Optional: set <code className="admin-deploy-code">VITE_DEPLOYMENTS_URL</code> for a custom
                      deployments page link; optional <code className="admin-deploy-code">VITE_SITE_ID</code> for
                      server env diagnostics.
                    </p>
                  ) : null}
                </>
              )}
            </div>
          </div>
        </div>
      </section>

      <footer className="admin-footer">
        <Button type="button" variant="outline" className="admin-back-btn" onClick={() => navigate("/")}>
          ← Back to Watchlist
        </Button>
      </footer>
    </main>
  );
}
