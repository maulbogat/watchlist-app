import { describe, expect, it } from "vitest";
import {
  buildUpcomingIcsDocument,
  compactUpcomingDetail,
  displayListName,
  errorMessage,
  formatUpcomingAirLabel,
  getUpcomingAirDateString,
  getUpcomingAirDateYmd,
  icsAllDayEndExclusiveYmd,
  icsEscapeText,
  icsFoldLine,
  safeIcsDownloadFilename,
  sanitizePosterUrl,
  upcomingAlertHasRealAirDate,
} from "./utils.js";

describe("errorMessage", () => {
  it("returns message from Error object", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("returns message property from object-like error", () => {
    expect(errorMessage({ message: "bad input" })).toBe("bad input");
  });

  it("returns fallback for null/undefined/plain string", () => {
    expect(errorMessage(null)).toBe("Unknown error");
    expect(errorMessage(undefined)).toBe("Unknown error");
    expect(errorMessage("oops")).toBe("Unknown error");
  });
});

describe("sanitizePosterUrl", () => {
  it("returns valid https URL unchanged", () => {
    const url = "https://m.media-amazon.com/images/M/poster.jpg";
    expect(sanitizePosterUrl(url)).toBe(url);
  });

  it("removes whitespace from URL", () => {
    expect(sanitizePosterUrl(" https://m.media-amazon.com/ a b.jpg \n")).toBe(
      "https://m.media-amazon.com/ab.jpg"
    );
  });

  it("returns empty string for null/undefined", () => {
    expect(sanitizePosterUrl(null)).toBe("");
    expect(sanitizePosterUrl(undefined)).toBe("");
  });
});

describe("displayListName", () => {
  it("returns name when present", () => {
    expect(displayListName("My List")).toBe("My List");
  });

  it("returns fallback for empty/whitespace", () => {
    expect(displayListName("")).toBe("Set name…");
    expect(displayListName("   ")).toBe("Set name…");
  });

  it("returns fallback for null/undefined", () => {
    expect(displayListName(null)).toBe("Set name…");
    expect(displayListName(undefined)).toBe("Set name…");
  });
});

describe("getUpcomingAirDateString", () => {
  it("returns string date unchanged", () => {
    expect(getUpcomingAirDateString({ airDate: "2026-03-17" })).toBe("2026-03-17");
  });

  it("handles Timestamp-like object with toDate()", () => {
    const date = getUpcomingAirDateString({
      airDate: { toDate: () => new Date("2026-01-02T10:00:00Z") },
    });
    expect(date).toBe("2026-01-02");
  });

  it("handles { seconds } and null input", () => {
    expect(getUpcomingAirDateString({ airDate: { seconds: 1735689600 } })).toBe("2025-01-01");
    expect(getUpcomingAirDateString(null)).toBe("");
  });

  it("returns empty string for invalid toDate()", () => {
    expect(
      getUpcomingAirDateString({
        airDate: { toDate: () => new Date("invalid") },
      })
    ).toBe("");
  });
});

describe("formatUpcomingAirLabel", () => {
  it("formats valid date string to readable label", () => {
    expect(formatUpcomingAirLabel({ airDate: "2026-03-17" })).toBe("Mar 17, 2026");
  });

  it("returns TBA for null/empty", () => {
    expect(formatUpcomingAirLabel({ airDate: null })).toBe("TBA");
    expect(formatUpcomingAirLabel({ airDate: "" })).toBe("TBA");
  });

  it("handles invalid date string gracefully", () => {
    expect(formatUpcomingAirLabel({ airDate: "not-a-date" })).toBe("not-a-date");
  });
});

describe("upcomingAlertHasRealAirDate", () => {
  it("returns true for valid date string", () => {
    expect(upcomingAlertHasRealAirDate({ airDate: "2026-03-17" })).toBe(true);
  });

  it("returns false for null and TBA", () => {
    expect(upcomingAlertHasRealAirDate({ airDate: null })).toBe(false);
    expect(upcomingAlertHasRealAirDate({ airDate: "TBA" })).toBe(false);
  });

  it("returns false for invalid date", () => {
    expect(upcomingAlertHasRealAirDate({ airDate: "not-a-date" })).toBe(false);
  });
});

describe("compactUpcomingDetail", () => {
  it("converts season/episode/name format", () => {
    expect(compactUpcomingDetail("Season 3, Episode 9 — Daddy Issues")).toBe(
      "S3 E9 · Daddy Issues"
    );
  });

  it("converts season/episode without name", () => {
    expect(compactUpcomingDetail("Season 1, Episode 1")).toBe("S1 E1");
  });

  it("returns non-matching string unchanged and handles empty", () => {
    expect(compactUpcomingDetail("Finale coming soon")).toBe("Finale coming soon");
    expect(compactUpcomingDetail("")).toBe("");
  });
});

describe("getUpcomingAirDateYmd", () => {
  it("returns YYYY-MM-DD for valid date", () => {
    expect(getUpcomingAirDateYmd({ airDate: "2026-03-17" })).toBe("2026-03-17");
  });

  it("returns empty string for TBA and null", () => {
    expect(getUpcomingAirDateYmd({ airDate: "TBA" })).toBe("");
    expect(getUpcomingAirDateYmd({ airDate: null })).toBe("");
  });

  it("returns empty string for invalid format", () => {
    expect(getUpcomingAirDateYmd({ airDate: "2026/03/17" })).toBe("");
  });
});

describe("icsEscapeText", () => {
  it("escapes backslashes and newlines", () => {
    expect(icsEscapeText("A\\B\nC")).toBe("A\\\\B\\nC");
  });

  it("escapes semicolons and commas", () => {
    expect(icsEscapeText("One;Two,Three")).toBe("One\\;Two\\,Three");
  });

  it("handles empty string", () => {
    expect(icsEscapeText("")).toBe("");
  });
});

describe("icsFoldLine", () => {
  it("returns short lines unchanged", () => {
    expect(icsFoldLine("short line")).toBe("short line");
  });

  it("does not fold exactly 73 characters", () => {
    const line = "a".repeat(73);
    expect(icsFoldLine(line)).toBe(line);
  });

  it("folds exactly 74 characters with CRLF + continuation space", () => {
    const line = "a".repeat(74);
    expect(icsFoldLine(line)).toBe(`${"a".repeat(73)}\r\n a`);
  });

  it("folds longer lines into continuation chunks", () => {
    const line = "b".repeat(160);
    const folded = icsFoldLine(line);
    expect(folded).toContain("\r\n ");
    expect(folded.replace(/\r\n /g, "")).toBe(line);
  });
});

describe("icsAllDayEndExclusiveYmd", () => {
  it("returns next day YYYYMMDD for valid date", () => {
    expect(icsAllDayEndExclusiveYmd("2026-01-15")).toBe("20260116");
  });

  it("returns null for invalid date", () => {
    expect(icsAllDayEndExclusiveYmd("not-a-date")).toBeNull();
  });

  it("rolls month boundary correctly", () => {
    expect(icsAllDayEndExclusiveYmd("2026-01-31")).toBe("20260201");
  });

  it("rolls year boundary correctly", () => {
    expect(icsAllDayEndExclusiveYmd("2025-12-31")).toBe("20260101");
  });
});

describe("buildUpcomingIcsDocument", () => {
  it("returns valid ICS document with required sections", () => {
    const ics = buildUpcomingIcsDocument({
      ymd: "2026-03-17",
      title: "My Show",
      detail: "Season 1, Episode 2",
      uid: "abc-123",
    });
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("DTSTART;VALUE=DATE:20260317");
    expect(ics).toContain("DTEND;VALUE=DATE:20260318");
    expect(ics).toContain("SUMMARY:My Show");
    expect(ics).toContain("DESCRIPTION:Season 1\\, Episode 2");
  });

  it("returns null for missing/invalid ymd", () => {
    expect(buildUpcomingIcsDocument({ ymd: "", title: "A", detail: "", uid: "u1" })).toBeNull();
    expect(
      buildUpcomingIcsDocument({ ymd: "20260317", title: "A", detail: "", uid: "u1" })
    ).toBeNull();
  });

  it("omits DESCRIPTION when detail is empty", () => {
    const ics = buildUpcomingIcsDocument({
      ymd: "2026-03-17",
      title: "No Detail",
      detail: "",
      uid: "u2",
    });
    expect(ics).toContain("SUMMARY:No Detail");
    expect(ics).not.toContain("DESCRIPTION:");
  });

  it("escapes special characters in title and detail", () => {
    const ics = buildUpcomingIcsDocument({
      ymd: "2026-03-17",
      title: "A;B,C\\D",
      detail: "Line 1\nLine 2",
      uid: "u3",
    });
    expect(ics).toContain("SUMMARY:A\\;B\\,C\\\\D");
    expect(ics).toContain("DESCRIPTION:Line 1\\nLine 2");
  });
});

describe("safeIcsDownloadFilename", () => {
  it("returns slugified filename with .ics", () => {
    expect(safeIcsDownloadFilename("My Upcoming Episode")).toBe("My-Upcoming-Episode.ics");
  });

  it("strips invalid filename characters and collapses spaces", () => {
    expect(safeIcsDownloadFilename('A/B:C*D?E"F<G>H|I')).toBe("ABCDEFGHI.ics");
  });

  it("returns upcoming.ics for empty/null input", () => {
    expect(safeIcsDownloadFilename("")).toBe("upcoming.ics");
    expect(safeIcsDownloadFilename(null as unknown as string)).toBe("upcoming.ics");
  });

  it("truncates long titles before extension", () => {
    const filename = safeIcsDownloadFilename("a".repeat(200));
    expect(filename.endsWith(".ics")).toBe(true);
    expect(filename.length).toBeLessThanOrEqual(76);
  });
});
