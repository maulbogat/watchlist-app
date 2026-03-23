import { useEffect, useMemo, useRef, useState } from "react";
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
] as const;

const ENV_VARS = [
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_APP_ID",
  "VITE_FIREBASE_MEASUREMENT_ID",
] as const;

const SERVER_ENV_VARS = ["TMDB_API_KEY", "OMDB_API_KEY", "FIREBASE_SERVICE_ACCOUNT"] as const;
type ServerEnvVar = (typeof SERVER_ENV_VARS)[number];

type ServerEnvResponse = {
  ok?: boolean;
  status?: Partial<Record<ServerEnvVar, boolean>>;
  error?: string;
};

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
  const time = date.toLocaleTimeString();
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

  const serverEnvQ = useQuery<Record<ServerEnvVar, boolean>>({
    queryKey: ["admin", "server-env-status"],
    staleTime: 60 * 1000,
    enabled: !authLoading && userIsAdmin,
    queryFn: async () => {
      const res = await fetch("/.netlify/functions/admin-env-status");
      const data = (await res.json()) as ServerEnvResponse;
      if (!res.ok || data.ok === false || !data.status) {
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      return {
        TMDB_API_KEY: Boolean(data.status.TMDB_API_KEY),
        OMDB_API_KEY: Boolean(data.status.OMDB_API_KEY),
        FIREBASE_SERVICE_ACCOUNT: Boolean(data.status.FIREBASE_SERVICE_ACCOUNT),
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
      const res = await fetch("/.netlify/functions/trigger-upcoming-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trigger: "manual" }),
      });
      const data = (await res.json()) as RunNowResponse;
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      return data;
    },
    onSuccess: (data) => {
      if (data.skipped) {
        showRunNowResult(data.reason || "Skipped");
      } else {
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

  const envRows = useMemo(() => {
    const env = import.meta.env as Record<string, string | boolean | undefined>;
    const clientRows = ENV_VARS.map((name) => ({
      name,
      state: Boolean(env[name]) ? "set" : "unset",
    }));
    const serverRows = SERVER_ENV_VARS.map((name) => {
      if (serverEnvQ.isPending) return { name, state: "unknown" as const };
      if (serverEnvQ.isError) return { name, state: "unknown" as const };
      return { name, state: serverEnvQ.data?.[name] ? ("set" as const) : ("unset" as const) };
    });
    return [...clientRows, ...serverRows];
  }, [serverEnvQ.data, serverEnvQ.isError, serverEnvQ.isPending]);

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

      <section className="admin-section">
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
                      jobConfigQ.data?.checkUpcomingEnabled ? "admin-job-status admin-job-status--on" : "admin-job-status"
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
      </section>

      <section className="admin-section">
        <h2>Environment</h2>
        <div className="admin-card admin-env-card">
          <table className="admin-env-table">
            <thead>
              <tr>
                <th>Variable</th>
                <th>Configured</th>
              </tr>
            </thead>
            <tbody>
              {envRows.map((row) => (
                <tr key={row.name}>
                  <td>{row.name}</td>
                  <td>
                    {row.state === "set" ? (
                      <span className="admin-env-ok">✓</span>
                    ) : row.state === "unset" ? (
                      <span className="admin-env-bad">✗</span>
                    ) : (
                      <span className="admin-env-unknown">…</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="admin-note">
            Server-side variables are shown via a Netlify function as configured/not-configured status only.
          </p>
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
