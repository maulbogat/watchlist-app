import { describe, expect, it, vi } from "vitest";
import { runCheckUpcomingUntilComplete, sleepMs } from "./upcoming-admin-sync.js";

describe("sleepMs", () => {
  it("resolves after delay", async () => {
    const t0 = Date.now();
    await sleepMs(15);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(10);
  });

  it("rejects when already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(sleepMs(1000, ac.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("runCheckUpcomingUntilComplete", () => {
  it("stops on first response when completed is true", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          ok: true,
          completed: true,
          alertsUpserted: 2,
          writesSkipped: 1,
          rowsChecked: 5,
        }),
    });

    const result = await runCheckUpcomingUntilComplete({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pauseMs: 0,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.batches).toBe(1);
      expect(result.totals).toEqual({
        alertsUpserted: 2,
        writesSkipped: 1,
        rowsChecked: 5,
      });
    }
  });

  it("loops until completed and sums per-batch totals", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            ok: true,
            completed: false,
            alertsUpserted: 1,
            writesSkipped: 0,
            rowsChecked: 3,
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            ok: true,
            completed: true,
            alertsUpserted: 2,
            writesSkipped: 4,
            rowsChecked: 2,
          }),
      });

    const result = await runCheckUpcomingUntilComplete({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pauseMs: 0,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.batches).toBe(2);
      expect(result.totals).toEqual({
        alertsUpserted: 3,
        writesSkipped: 4,
        rowsChecked: 5,
      });
    }
  });

  it("returns skipped path without requiring completed", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          ok: true,
          skipped: true,
          reason: "quota_exceeded",
        }),
    });

    const result = await runCheckUpcomingUntilComplete({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pauseMs: 0,
    });

    expect(result.ok).toBe(true);
    if (result.ok && result.skipped) {
      expect(result.reason).toBe("quota_exceeded");
      expect(result.totals).toEqual({ alertsUpserted: 0, writesSkipped: 0, rowsChecked: 0 });
    }
  });

  it("does not fetch when signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const fetchImpl = vi.fn();
    const result = await runCheckUpcomingUntilComplete({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pauseMs: 0,
      signal: ac.signal,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Cancelled");
  });

  it("honours abort during pause between batches", async () => {
    const ac = new AbortController();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          ok: true,
          completed: false,
          rowsChecked: 1,
        }),
    });

    const p = runCheckUpcomingUntilComplete({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pauseMs: 500,
      signal: ac.signal,
    });

    setTimeout(() => {
      ac.abort();
    }, 15);

    const result = await p;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Cancelled");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
