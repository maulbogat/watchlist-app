import { useEffect, useRef, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useAppStore } from "../store/useAppStore.js";
import { isAdmin } from "../config/admin.js";
import { useAuthUser } from "../hooks/useAuthUser.js";
import { getJobConfigState, setCheckUpcomingEnabledState } from "../firebase.js";
import { getFirestore, collection, getCountFromServer, getDocs } from "firebase/firestore";

type CatalogStats = {
  totalTitles: number | "Error";
  missingTmdbId: number | "Error";
  missingYoutubeId: number | "Error";
};

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

const SERVICE_LINKS = [
  {
    label: "Watchlist",
    sublabel: "Production List",
    url: "https://watchlist-trailers.netlify.app/",
  },
  {
    label: "Firebase",
    sublabel: "Firestore Data",
    url: "https://console.firebase.google.com/u/0/project/movie-trailer-site/firestore/databases/-default-/data/",
  },
  {
    label: "Netlify",
    sublabel: "Environment Variables",
    url: "https://app.netlify.com/projects/watchlist-trailers/configuration/env#environment-variables",
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
    /* Avoid embedding the real dataset slug — it may match Netlify secret AXIOM_DATASET and fail the build. */
    url: "https://app.axiom.co/",
  },
] as const;

/** Netlify dashboard URL uses this slug (`/projects/<slug>/…`). */
const NETLIFY_PROJECT_SLUG =
  (import.meta.env.VITE_NETLIFY_PROJECT_SLUG as string | undefined)?.trim() || "watchlist-trailers";

const NETLIFY_DEPLOYS_URL = `https://app.netlify.com/projects/${NETLIFY_PROJECT_SLUG}/deploys`;

const netlifySiteId = (import.meta.env.VITE_NETLIFY_SITE_ID as string | undefined)?.trim();
const NETLIFY_DEPLOY_BADGE_URL = netlifySiteId
  ? `https://api.netlify.com/api/v1/badges/${encodeURIComponent(netlifySiteId)}/deploy-status`
  : null;

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
      const db = getFirestore();
      const base: CatalogStats = {
        totalTitles: "Error",
        missingTmdbId: "Error",
        missingYoutubeId: "Error",
      };

      try {
        const titleRegistryRef = collection(db, "titleRegistry");
        const totalTitlesSnap = await getCountFromServer(titleRegistryRef);
        base.totalTitles = totalTitlesSnap.data().count;

        const projectedRegistryRef =
          (titleRegistryRef as MaybeSelectable<typeof titleRegistryRef>).select?.("tmdbId", "youtubeId") ??
          titleRegistryRef;
        const registrySnap = await getDocs(projectedRegistryRef);
        let missingTmdbId = 0;
        let missingYoutubeId = 0;
        registrySnap.forEach((d) => {
          const rec = d.data() as Record<string, unknown>;
          if (rec.tmdbId == null || rec.tmdbId === "") missingTmdbId += 1;
          if (rec.youtubeId == null || rec.youtubeId === "") missingYoutubeId += 1;
        });
        base.missingTmdbId = missingTmdbId;
        base.missingYoutubeId = missingYoutubeId;
      } catch (err) {
        console.error("Admin catalog/titleRegistry stats failed:", err);
      }

      return base;
    },
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
      const res = await fetch("/.netlify/functions/check-upcoming", {
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
        <h2>Catalog Stats</h2>
        <div className="admin-grid admin-grid--stats">
          {catalogStatsQ.isPending
            ? Array.from({ length: 5 }).map((_, idx) => (
                <div key={`catalog-skeleton-${idx}`} className="admin-card admin-stat-card admin-skeleton" />
              ))
            : [
                { label: "Total titles in catalog", value: catalogStatsQ.data?.totalTitles },
                { label: "Titles missing tmdbId", value: catalogStatsQ.data?.missingTmdbId },
                { label: "Titles missing youtubeId", value: catalogStatsQ.data?.missingYoutubeId },
              ].map((s) => (
                <div key={s.label} className="admin-card admin-stat-card">
                  <div className="admin-stat-label">{s.label}</div>
                  <div className="admin-stat-value">{String(s.value ?? "0")}</div>
                </div>
              ))}
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
            <h2>Jobs</h2>
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
                  <div className="admin-job-row">
                    <span className="admin-stat-label">Upcoming check enabled</span>
                    <div className="admin-job-actions">
                      <span
                        className={
                          jobConfigQ.data?.checkUpcomingEnabled
                            ? "admin-job-status admin-job-status--on"
                            : "admin-job-status"
                        }
                      >
                        {jobConfigQ.data?.checkUpcomingEnabled ? "Enabled" : "Disabled"}
                      </span>
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
                  <div className="admin-job-row">
                    <span className="admin-stat-label">Last run timestamp</span>
                    <span className="admin-job-value">
                      {formatDateTime(toEpochMs(jobConfigQ.data?.lastRunAt ?? null)) || "N/A"}
                    </span>
                  </div>
                  <div className="admin-job-row">
                    <span className="admin-stat-label">Last run result</span>
                    <span className="admin-job-value">
                      {jobConfigQ.data?.lastRunStatus || "N/A"}
                      {jobConfigQ.data?.lastRunMessage ? ` — ${jobConfigQ.data.lastRunMessage}` : ""}
                    </span>
                  </div>
                  <div className="admin-job-row admin-job-row--actions">
                    <Button
                      type="button"
                      className="admin-job-run-btn"
                      disabled={runNowMutation.isPending || toggleJobMutation.isPending}
                      onClick={() => runNowMutation.mutate()}
                    >
                      {runNowMutation.isPending ? "Running…" : "Run Now"}
                    </Button>
                  </div>
                  {runNowResult ? <p className="admin-job-result">{runNowResult}</p> : null}
                </>
              )}
            </div>
          </div>
          <div className="admin-jobs-deploy-col">
            <h2>Last deployment</h2>
            <div className="admin-deploy-stack">
              <div className="admin-card admin-deploy-card">
                {NETLIFY_DEPLOY_BADGE_URL ? (
                  <a
                    className="admin-deploy-link"
                    href={NETLIFY_DEPLOYS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Open Netlify deploys and build logs"
                  >
                    <img
                      className="admin-deploy-badge"
                      src={NETLIFY_DEPLOY_BADGE_URL}
                      alt=""
                      decoding="async"
                    />
                  </a>
                ) : (
                  <p className="admin-deploy-fallback">
                    <a
                      className="admin-deploy-text-link"
                      href={NETLIFY_DEPLOYS_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Netlify deploys
                      <span aria-hidden="true"> ↗</span>
                    </a>
                    <span className="admin-deploy-hint">
                      {" "}
                      · set <code className="admin-deploy-code">VITE_NETLIFY_SITE_ID</code> for the status badge
                    </span>
                  </p>
                )}
              </div>
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
