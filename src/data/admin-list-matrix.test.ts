import { describe, expect, it } from "vitest";
import type { MatrixUiChoice } from "../lib/admin-list-matrix.js";
import { buildMatrixSubmitDiffs, type MatrixListColumnSnapshot } from "./admin-list-matrix.js";

function col(
  partial: Partial<MatrixListColumnSnapshot> & Pick<MatrixListColumnSnapshot, "columnKey">
): MatrixListColumnSnapshot {
  return {
    name: "L",
    kind: "personal",
    listMode: "personal",
    itemKeys: new Set(),
    watched: new Set(),
    maybeLater: new Set(),
    archive: new Set(),
    ...partial,
  };
}

describe("buildMatrixSubmitDiffs", () => {
  it("returns empty when overrides match membership", () => {
    const columns = [
      col({
        columnKey: "p:personal",
        itemKeys: new Set(["tt1"]),
        watched: new Set(["tt1"]),
      }),
    ];
    const overrides = new Map<string, Map<string, MatrixUiChoice>>([
      ["tt1", new Map([["p:personal", "watched"]])],
    ]);
    expect(buildMatrixSubmitDiffs(columns, overrides)).toEqual([]);
  });

  it("emits diff when override differs", () => {
    const columns = [
      col({
        columnKey: "p:personal",
        itemKeys: new Set(["tt1"]),
        watched: new Set(),
      }),
    ];
    const overrides = new Map<string, Map<string, MatrixUiChoice>>([
      ["tt1", new Map([["p:personal", "watched"]])],
    ]);
    expect(buildMatrixSubmitDiffs(columns, overrides)).toEqual([
      { registryId: "tt1", columnKey: "p:personal", from: "queue", to: "watched" },
    ]);
  });
});
