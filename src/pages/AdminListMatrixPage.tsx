import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryDocumentSnapshot } from "firebase/firestore";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppStore } from "../store/useAppStore.js";
import { isAdmin } from "../config/admin.js";
import { membershipToMatrixChoice, type MatrixUiChoice } from "../lib/admin-list-matrix.js";
import {
  applyAdminListMatrixDiffs,
  buildMatrixSubmitDiffs,
  loadAdminListMatrixColumns,
  loadTitleRegistryPage,
  matrixCellChoice,
  watchlistItemFromCatalogRow,
  type CatalogMatrixRow,
  type MatrixListColumnSnapshot,
} from "../data/admin-list-matrix.js";
import { invalidateUserListQueries } from "../hooks/useWatchlist.js";
import type { WatchlistItem } from "../types/index.js";
import { toast } from "sonner";

const CHOICE_ORDER: MatrixUiChoice[] = ["queue", "watched", "archive", "absent"];

const CHOICE_LABEL: Record<MatrixUiChoice, string> = {
  queue: "To watch",
  watched: "Watched",
  archive: "Archive",
  absent: "Not on list",
};

export function AdminListMatrixPage() {
  const currentUser = useAppStore((s) => s.currentUser);
  const uid = currentUser?.uid;
  const userIsAdmin = Boolean(uid && isAdmin(uid));
  const queryClient = useQueryClient();

  const [pageIndex, setPageIndex] = useState(0);
  const endsRef = useRef<QueryDocumentSnapshot[]>([]);
  const itemCacheRef = useRef(new Map<string, WatchlistItem>());

  const [overrides, setOverrides] = useState<Map<string, Map<string, MatrixUiChoice>>>(
    () => new Map()
  );
  const [titleFilter, setTitleFilter] = useState("");

  const columnsQ = useQuery({
    queryKey: ["adminListMatrixColumns", uid],
    queryFn: () => loadAdminListMatrixColumns(uid!),
    enabled: Boolean(userIsAdmin && uid),
    staleTime: 30_000,
  });

  const catalogQ = useQuery({
    queryKey: ["adminMatrixCatalog", uid, pageIndex],
    queryFn: async () => {
      const start = pageIndex === 0 ? null : (endsRef.current[pageIndex - 1] ?? null);
      if (pageIndex > 0 && !start) {
        throw new Error("Missing page cursor; go back to the first page.");
      }
      return loadTitleRegistryPage(start);
    },
    enabled: Boolean(userIsAdmin && uid),
    staleTime: 0,
  });

  useEffect(() => {
    const last = catalogQ.data?.lastDoc;
    if (last != null) {
      endsRef.current[pageIndex] = last;
    }
  }, [catalogQ.data?.lastDoc, pageIndex]);

  useEffect(() => {
    const rows = catalogQ.data?.rows;
    if (!rows) return;
    for (const r of rows) {
      itemCacheRef.current.set(r.id, watchlistItemFromCatalogRow(r));
    }
  }, [catalogQ.data?.rows]);

  const columns = useMemo(() => columnsQ.data ?? [], [columnsQ.data]);

  const filteredRows = useMemo(() => {
    const rows = catalogQ.data?.rows ?? [];
    const q = titleFilter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.title.toLowerCase().includes(q));
  }, [catalogQ.data?.rows, titleFilter]);

  const pendingDiffs = useMemo(
    () => buildMatrixSubmitDiffs(columns, overrides),
    [columns, overrides]
  );

  const setCellOverride = useCallback(
    (registryId: string, columnKey: string, value: MatrixUiChoice) => {
      const col = columns.find((c) => c.columnKey === columnKey);
      if (!col) return;
      const baseline = membershipToMatrixChoice(
        registryId,
        col.itemKeys,
        col.watched,
        col.maybeLater,
        col.archive
      );
      setOverrides((prev) => {
        const next = new Map(prev);
        const inner = new Map(next.get(registryId) ?? []);
        if (value === baseline) {
          inner.delete(columnKey);
          if (inner.size === 0) next.delete(registryId);
          else next.set(registryId, inner);
        } else {
          inner.set(columnKey, value);
          next.set(registryId, inner);
        }
        return next;
      });
    },
    [columns]
  );

  const submitM = useMutation({
    mutationFn: async () => {
      if (!uid) throw new Error("Not signed in");
      const diffs = buildMatrixSubmitDiffs(columns, overrides);
      await applyAdminListMatrixDiffs(uid, columns, diffs, itemCacheRef.current);
      return diffs.length;
    },
    onSuccess: async (savedCount) => {
      toast.success(`Saved ${savedCount} change(s).`);
      setOverrides(new Map());
      setPageIndex(0);
      endsRef.current = [];
      await queryClient.invalidateQueries({ queryKey: ["adminListMatrixColumns", uid] });
      await queryClient.invalidateQueries({ queryKey: ["adminMatrixCatalog", uid] });
      void invalidateUserListQueries(queryClient, uid);
      void columnsQ.refetch();
    },
    onError: (e: Error) => {
      toast.error(e.message || "Save failed");
    },
  });

  const discard = useCallback(() => {
    setOverrides(new Map());
    toast.message("Discarded unsaved changes.");
  }, []);

  if (!userIsAdmin) {
    return <Navigate to="/" replace />;
  }

  const loading = columnsQ.isPending || catalogQ.isPending;
  const hasMore = catalogQ.data?.hasMore ?? false;
  const catalogError = catalogQ.error instanceof Error ? catalogQ.error.message : null;

  return (
    <main className="admin-page admin-page--wide">
      <header className="admin-header">
        <h1>List matrix</h1>
        <p className="admin-subtitle">
          {currentUser?.email ?? "Unknown"} ·{" "}
          <Link to="/admin" className="admin-matrix-back">
            Back to admin
          </Link>
        </p>
      </header>

      <section className="admin-section admin-matrix-intro">
        <p className="admin-matrix-help">
          Each row is a catalog title. Each list is a column group with four choices: To watch
          (includes maybe-later), Watched, Archive, or Not on list. Changes apply only when you
          click Submit. Scroll inside the table panel — header rows stay pinned while you move
          through titles.
        </p>
        <div className="admin-matrix-toolbar">
          <label className="admin-matrix-filter">
            <span className="admin-matrix-filter-label">Filter title</span>
            <input
              type="search"
              className="admin-matrix-filter-input"
              value={titleFilter}
              onChange={(e) => setTitleFilter(e.target.value)}
              placeholder="Contains…"
              autoComplete="off"
            />
          </label>
          <div className="admin-matrix-toolbar-actions">
            <span className="admin-matrix-pending" role="status">
              {pendingDiffs.length} unsaved change{pendingDiffs.length === 1 ? "" : "s"}
            </span>
            <Button
              type="button"
              variant="outline"
              onClick={discard}
              disabled={pendingDiffs.length === 0}
            >
              Discard
            </Button>
            <Button
              type="button"
              className="btn-primary"
              disabled={pendingDiffs.length === 0 || submitM.isPending}
              onClick={() => void submitM.mutate()}
            >
              {submitM.isPending ? (
                <>
                  <Loader2 className="admin-matrix-spin" aria-hidden />
                  Saving…
                </>
              ) : (
                "Submit"
              )}
            </Button>
          </div>
        </div>
      </section>

      {columnsQ.isError ? (
        <p className="admin-matrix-error" role="alert">
          {columnsQ.error instanceof Error ? columnsQ.error.message : "Could not load lists."}
        </p>
      ) : columns.length === 0 && !columnsQ.isPending ? (
        <p className="admin-matrix-empty">No personal or shared lists found.</p>
      ) : null}

      {catalogError ? (
        <p className="admin-matrix-error" role="alert">
          {catalogError}
        </p>
      ) : null}

      <section className="admin-section admin-matrix-section">
        <div className="admin-matrix-pagebar">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pageIndex === 0 || loading}
            onClick={() => setPageIndex((p) => Math.max(0, p - 1))}
          >
            Previous page
          </Button>
          <span className="admin-matrix-page-label">
            Page {pageIndex + 1}
            {loading ? " · Loading…" : ""}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!hasMore || loading}
            onClick={() => setPageIndex((p) => p + 1)}
          >
            Next page
          </Button>
        </div>

        <div className="admin-matrix-scroll">
          {loading ? (
            <p className="admin-matrix-loading">
              <Loader2 className="admin-matrix-spin" aria-hidden /> Loading…
            </p>
          ) : (
            <table className="admin-matrix-table">
              <thead>
                <tr className="admin-matrix-thead-row1">
                  <th rowSpan={2} scope="col" className="admin-matrix-th admin-matrix-th--title">
                    Title
                  </th>
                  {columns.map((c) => (
                    <th
                      key={c.columnKey}
                      scope="colgroup"
                      colSpan={4}
                      className="admin-matrix-th admin-matrix-th--list"
                    >
                      <span className="admin-matrix-list-name">{c.name}</span>
                      <span className="admin-matrix-list-kind">
                        {c.kind === "shared" ? "Shared" : "Personal"}
                      </span>
                    </th>
                  ))}
                </tr>
                <tr className="admin-matrix-thead-row2">
                  {columns.flatMap((c) =>
                    CHOICE_ORDER.map((choice) => (
                      <th
                        key={`${c.columnKey}-${choice}`}
                        scope="col"
                        className="admin-matrix-th admin-matrix-th--choice"
                      >
                        {CHOICE_LABEL[choice]}
                      </th>
                    ))
                  )}
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => (
                  <MatrixRow
                    key={row.id}
                    row={row}
                    columns={columns}
                    overrides={overrides}
                    onPick={setCellOverride}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </main>
  );
}

function MatrixRow({
  row,
  columns,
  overrides,
  onPick,
}: {
  row: CatalogMatrixRow;
  columns: MatrixListColumnSnapshot[];
  overrides: Map<string, Map<string, MatrixUiChoice>>;
  onPick: (registryId: string, columnKey: string, value: MatrixUiChoice) => void;
}) {
  const rid = row.id;
  const rowOverrides = overrides.get(rid);

  return (
    <tr className="admin-matrix-tr">
      <th scope="row" className="admin-matrix-title-cell">
        <span className="admin-matrix-title-text">{row.title}</span>
        <span className="admin-matrix-year">{row.yearLabel}</span>
      </th>
      {columns.map((col) =>
        CHOICE_ORDER.map((choice) => {
          const selected = matrixCellChoice(rid, col, rowOverrides?.get(col.columnKey));
          const name = `m-${rid}-${col.columnKey}`;
          return (
            <td key={`${col.columnKey}-${choice}`} className="admin-matrix-td-radio">
              <input
                type="radio"
                name={name}
                className="admin-matrix-radio"
                checked={selected === choice}
                onChange={() => onPick(rid, col.columnKey, choice)}
                aria-label={`${row.title} — ${col.name} — ${CHOICE_LABEL[choice]}`}
              />
            </td>
          );
        })
      )}
    </tr>
  );
}
