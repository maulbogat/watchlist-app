import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { resolveStatusForCrossListAdd } from "./resolve-add-item-status.js";
import type { WatchlistItem } from "../types/index.js";

const base: WatchlistItem = {
  registryId: "tt123",
  title: "Test",
  year: 2020,
  type: "movie",
  genre: "",
  thumb: null,
  youtubeId: null,
  imdbId: "tt123",
  tmdbId: 1,
  services: [],
  servicesByRegion: null,
};

describe("resolveStatusForCrossListAdd", () => {
  it("uses status from source list cache when the row exists", () => {
    const qc = new QueryClient();
    qc.setQueryData(["watchlistMovies", "u1", "personal", "list-a"], [
      { ...base, status: "watched" },
    ]);
    const out = resolveStatusForCrossListAdd(
      { ...base, status: "to-watch" },
      "u1",
      { type: "personal", listId: "list-a" },
      qc
    );
    expect(out).toBe("watched");
  });

  it("falls back to item.status when source cache has no row", () => {
    const qc = new QueryClient();
    qc.setQueryData(["watchlistMovies", "u1", "personal", "list-a"], []);
    const out = resolveStatusForCrossListAdd(
      { ...base, status: "watched" },
      "u1",
      { type: "personal", listId: "list-a" },
      qc
    );
    expect(out).toBe("watched");
  });

  it("defaults missing status to to-watch", () => {
    const qc = new QueryClient();
    const { status: _s, ...noStatus } = base;
    void _s;
    const out = resolveStatusForCrossListAdd(noStatus, "u1", { type: "personal", listId: "list-a" }, qc);
    expect(out).toBe("to-watch");
  });
});
