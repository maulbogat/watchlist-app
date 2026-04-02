import { describe, expect, it } from "vitest";
import {
  diffMatrixChoices,
  matrixChoiceToStatusKey,
  membershipToMatrixChoice,
  type MatrixUiChoice,
} from "./admin-list-matrix.js";

describe("membershipToMatrixChoice", () => {
  const empty = new Set<string>();

  it("returns absent when key not in items", () => {
    expect(membershipToMatrixChoice("tt123", empty, empty, empty, empty)).toBe("absent");
  });

  it("returns archive when in archive", () => {
    const items = new Set(["tt1"]);
    expect(membershipToMatrixChoice("tt1", items, empty, empty, new Set(["tt1"]))).toBe("archive");
  });

  it("returns watched when in watched", () => {
    const items = new Set(["tt1"]);
    expect(membershipToMatrixChoice("tt1", items, new Set(["tt1"]), empty, empty)).toBe("watched");
  });

  it("returns queue for maybe-later", () => {
    const items = new Set(["tt1"]);
    expect(membershipToMatrixChoice("tt1", items, empty, new Set(["tt1"]), empty)).toBe("queue");
  });

  it("returns queue for plain to-watch (in items only)", () => {
    const items = new Set(["tt1"]);
    expect(membershipToMatrixChoice("tt1", items, empty, empty, empty)).toBe("queue");
  });

  it("prefers archive over watched if both present", () => {
    const items = new Set(["tt1"]);
    expect(membershipToMatrixChoice("tt1", items, new Set(["tt1"]), empty, new Set(["tt1"]))).toBe(
      "archive"
    );
  });
});

describe("matrixChoiceToStatusKey", () => {
  it("maps queue to to-watch", () => {
    expect(matrixChoiceToStatusKey("queue")).toBe("to-watch");
  });
  it("maps watched and archive", () => {
    expect(matrixChoiceToStatusKey("watched")).toBe("watched");
    expect(matrixChoiceToStatusKey("archive")).toBe("archive");
  });
});

describe("diffMatrixChoices", () => {
  function mapOf(
    entries: [string, [string, MatrixUiChoice][]][]
  ): Map<string, Map<string, MatrixUiChoice>> {
    const m = new Map<string, Map<string, MatrixUiChoice>>();
    for (const [rid, cols] of entries) {
      m.set(rid, new Map(cols));
    }
    return m;
  }

  it("returns empty when identical", () => {
    const b = mapOf([["a", [["L1", "queue"]]]]);
    expect(diffMatrixChoices(b, b).length).toBe(0);
  });

  it("detects changes and new rows in draft", () => {
    const baseline = mapOf([["a", [["L1", "absent"]]]]);
    const draft = mapOf([["a", [["L1", "watched"]]]]);
    expect(diffMatrixChoices(baseline, draft)).toEqual([
      { registryId: "a", columnKey: "L1", from: "absent", to: "watched" },
    ]);
  });
});
