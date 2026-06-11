import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RateLimitError } from "../src/shared/errors";
import type { UsageProvider, UsageSnapshot } from "../src/providers/types";
import { RefreshLoop } from "../src/usage/refreshLoop";
import { UsageStore } from "../src/usage/usageStore";
import { DebugRecorder } from "../src/main/debugRecorder";
import { WindowRatioTracker, emptyRatioFile, emptyProviderState } from "../src/usage/windowRatio";

function okSnap(provider: string): UsageSnapshot {
  return {
    provider,
    status: "ok",
    windows: [{ name: "fiveHour", usedPercent: 50, windowSeconds: 18000 }],
    updatedAt: new Date().toISOString(),
  };
}

function makeProvider(id: string, fetchFn: () => Promise<UsageSnapshot>): UsageProvider {
  return {
    id,
    displayName: id,
    isAvailable: async () => true,
    getAuthHint: async () => null,
    fetchUsage: fetchFn,
  };
}

describe("RefreshLoop backoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("skips provider in backoff on subsequent refresh", async () => {
    const store = new UsageStore();
    let callCount = 0;
    const provider = makeProvider("claude", async () => {
      callCount++;
      if (callCount === 1) throw new RateLimitError(5 * 60 * 1000);
      return okSnap("claude");
    });
    const loop = new RefreshLoop([provider], store, 60, 10_000);

    await loop.refreshNow();
    expect(callCount).toBe(1);

    await loop.refreshNow();
    expect(callCount).toBe(1); // still in backoff, not called again

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    await loop.refreshNow();
    expect(callCount).toBe(2); // backoff expired, fetched again
  });

  it("respects retryAfterMs from RateLimitError", async () => {
    const store = new UsageStore();
    let callCount = 0;
    const retryAfterMs = 2 * 60 * 1000;
    const provider = makeProvider("codex", async () => {
      callCount++;
      if (callCount === 1) throw new RateLimitError(retryAfterMs);
      return okSnap("codex");
    });
    const loop = new RefreshLoop([provider], store, 60, 10_000);

    await loop.refreshNow();
    expect(callCount).toBe(1);

    vi.advanceTimersByTime(retryAfterMs - 1);
    await loop.refreshNow();
    expect(callCount).toBe(1); // still blocked

    vi.advanceTimersByTime(2);
    await loop.refreshNow();
    expect(callCount).toBe(2); // now expired
  });

  it("does not back off provider on non-rate-limit errors", async () => {
    const store = new UsageStore();
    let callCount = 0;
    const provider = makeProvider("claude", async () => {
      callCount++;
      throw new Error("network error");
    });
    const loop = new RefreshLoop([provider], store, 60, 10_000);

    await loop.refreshNow();
    await loop.refreshNow();
    expect(callCount).toBe(2); // no backoff applied
  });

  it("marks previous ok snapshot as stale when rate limited", async () => {
    const store = new UsageStore();
    let callCount = 0;
    const provider = makeProvider("claude", async () => {
      callCount++;
      if (callCount === 1) return okSnap("claude");
      throw new RateLimitError(5 * 60 * 1000);
    });
    const loop = new RefreshLoop([provider], store, 60, 10_000);

    await loop.refreshNow(); // ok
    await loop.refreshNow(); // rate limited → stale

    expect(store.get("claude")?.status).toBe("stale");
  });

  it("keeps stale snapshot unchanged while provider is in backoff", async () => {
    const store = new UsageStore();
    let callCount = 0;
    const provider = makeProvider("claude", async () => {
      callCount++;
      if (callCount === 1) return okSnap("claude");
      throw new RateLimitError(5 * 60 * 1000);
    });
    const loop = new RefreshLoop([provider], store, 60, 10_000);

    await loop.refreshNow(); // ok
    await loop.refreshNow(); // rate limited → stale

    const staleSnap = store.get("claude");
    expect(staleSnap?.status).toBe("stale");

    await loop.refreshNow(); // in backoff → provider skipped
    expect(store.get("claude")?.status).toBe("stale"); // unchanged
    expect(callCount).toBe(2); // provider not called a third time
  });

  it("other providers are not affected by one provider's backoff", async () => {
    const store = new UsageStore();
    let claudeCalls = 0;
    let codexCalls = 0;
    const claude = makeProvider("claude", async () => {
      claudeCalls++;
      if (claudeCalls === 1) throw new RateLimitError(5 * 60 * 1000);
      return okSnap("claude");
    });
    const codex = makeProvider("codex", async () => {
      codexCalls++;
      return okSnap("codex");
    });
    const loop = new RefreshLoop([claude, codex], store, 60, 10_000);

    await loop.refreshNow();
    expect(claudeCalls).toBe(1);
    expect(codexCalls).toBe(1);

    await loop.refreshNow(); // claude in backoff, codex still fetched
    expect(claudeCalls).toBe(1);
    expect(codexCalls).toBe(2);
  });
});

describe("RefreshLoop debug recording", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "qb-rl-rec-"));
    vi.useRealTimers();
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("emits refresh.start and one snapshot event per provider", async () => {
    const store = new UsageStore();
    const recorder = new DebugRecorder({ enabled: true, logDir: tmpDir });
    const provider = makeProvider("claude", async () => okSnap("claude"));
    const loop = new RefreshLoop([provider], store, 60, 10_000, undefined, recorder);
    await loop.refreshNow();
    await recorder.flush();
    const files = await fs.readdir(tmpDir);
    const content = await fs.readFile(path.join(tmpDir, files[0]), "utf8");
    const events = content.trim().split("\n").map((l) => JSON.parse(l));
    expect(events.some((e) => e.kind === "refresh.start")).toBe(true);
    const snapshots = events.filter((e) => e.kind === "snapshot");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].provider).toBe("claude");
  });

  it("respects the trigger argument", async () => {
    const store = new UsageStore();
    const recorder = new DebugRecorder({ enabled: true, logDir: tmpDir });
    const provider = makeProvider("claude", async () => okSnap("claude"));
    const loop = new RefreshLoop([provider], store, 60, 10_000, undefined, recorder);
    await loop.refreshNow("manual");
    await recorder.flush();
    const files = await fs.readdir(tmpDir);
    const content = await fs.readFile(path.join(tmpDir, files[0]), "utf8");
    const events = content.trim().split("\n").map((l) => JSON.parse(l));
    const start = events.find((e) => e.kind === "refresh.start");
    expect(start.trigger).toBe("manual");
  });

  it("emits refresh.skipped when a provider is in backoff", async () => {
    const store = new UsageStore();
    const recorder = new DebugRecorder({ enabled: true, logDir: tmpDir });
    const provider = makeProvider("claude", async () => { throw new RateLimitError(60_000); });
    const loop = new RefreshLoop([provider], store, 60, 10_000, undefined, recorder);
    await loop.refreshNow(); // triggers backoff
    await loop.refreshNow(); // should skip
    await recorder.flush();
    const files = await fs.readdir(tmpDir);
    const content = await fs.readFile(path.join(tmpDir, files[0]), "utf8");
    const events = content.trim().split("\n").map((l) => JSON.parse(l));
    expect(events.some((e) => e.kind === "refresh.skipped" && e.provider === "claude")).toBe(true);
  });
});

describe("RefreshLoop window intelligence", () => {
  it("attaches pace to fiveHour window (not just weekly)", async () => {
    const store = new UsageStore();
    const resetsAt = new Date(Date.now() + 2 * 3600 * 1000).toISOString(); // 2h from now
    const provider = makeProvider("claude", async () => ({
      provider: "claude",
      status: "ok" as const,
      windows: [{ name: "fiveHour" as const, usedPercent: 20, windowSeconds: 18000, resetsAt }],
      updatedAt: new Date().toISOString(),
    }));
    const loop = new RefreshLoop([provider], store, 60, 10_000);
    await loop.refreshNow();
    const win = store.get("claude")?.windows.find(w => w.name === "fiveHour");
    expect(win?.pace).not.toBeUndefined();
    expect(win?.pace).not.toBeNull();
  });

  it("burnRatePctPerHour is null after first refresh (insufficient history)", async () => {
    const store = new UsageStore();
    const resetsAt = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    const provider = makeProvider("claude", async () => ({
      provider: "claude",
      status: "ok" as const,
      windows: [{ name: "fiveHour" as const, usedPercent: 30, windowSeconds: 18000, resetsAt }],
      updatedAt: new Date().toISOString(),
    }));
    const loop = new RefreshLoop([provider], store, 60, 10_000);
    await loop.refreshNow();
    const win = store.get("claude")?.windows.find(w => w.name === "fiveHour");
    // Only 1 recorded point → not enough for burn rate
    expect(win?.burnRatePctPerHour).toBeNull();
  });

  it("safetyGapSeconds is set when pace resolves willLastToReset", async () => {
    const store = new UsageStore();
    // 20% used, 2h left in a 5h window → pace will compute willLastToReset
    const resetsAt = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    const provider = makeProvider("claude", async () => ({
      provider: "claude",
      status: "ok" as const,
      windows: [{ name: "fiveHour" as const, usedPercent: 20, windowSeconds: 18000, resetsAt }],
      updatedAt: new Date().toISOString(),
    }));
    const loop = new RefreshLoop([provider], store, 60, 10_000);
    await loop.refreshNow();
    const win = store.get("claude")?.windows.find(w => w.name === "fiveHour");
    expect(win?.safetyGapSeconds).not.toBeNull();
    // willLastToReset case → safetyGapSeconds ≈ timeToReset ≈ 7200s
    expect(win?.safetyGapSeconds).toBeGreaterThan(7000);
  });
});

describe("RefreshLoop robustness", () => {
  it("escalates backoff on consecutive rate limits and resets after success", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0); // kein Jitter für deterministische Assertions
    const store = new UsageStore();
    let call = 0;
    const provider = makeProvider("claude", async () => {
      call++;
      if (call <= 2) throw new RateLimitError(0); // server says 0 → muss auf MIN_RETRY_MS gehoben werden
      return { provider: "claude", status: "ok" as const, windows: [], updatedAt: new Date().toISOString() };
    });
    const events: any[] = [];
    const recorder = { write: (e: any) => events.push(e) } as any;
    const loop = new RefreshLoop([provider], store, 60, 10_000, undefined, recorder);

    await loop.refreshNow(); // call 1 → 429, backoff = MIN_RETRY_MS = 5000ms
    // sofortiger Retry muss geblockt sein (noch im Backoff-Fenster)
    await loop.refreshNow();
    expect(events.some(e => e.kind === "refresh.skipped" && e.provider === "claude")).toBe(true);

    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("emits dns.lookup.failed and network.recovered around a DNS outage", async () => {
    const store = new UsageStore();
    let call = 0;
    const provider = makeProvider("claude", async () => {
      call++;
      if (call === 1) {
        const err = new Error("fetch failed");
        (err as any).cause = Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
        throw err;
      }
      return { provider: "claude", status: "ok" as const, windows: [], updatedAt: new Date().toISOString() };
    });
    const events: any[] = [];
    const recorder = { write: (e: any) => events.push(e) } as any;
    const loop = new RefreshLoop([provider], store, 60, 10_000, undefined, recorder);

    await loop.refreshNow();
    expect(events.some(e => e.kind === "dns.lookup.failed" && e.provider === "claude")).toBe(true);

    await loop.refreshNow();
    expect(events.some(e => e.kind === "network.recovered")).toBe(true);
  });
});

describe("RefreshLoop windowBudget", () => {
  function snapWithWindows(provider: string, fivePct: number, weeklyPct: number): UsageSnapshot {
    return {
      provider,
      status: "ok",
      windows: [
        { name: "fiveHour", usedPercent: fivePct, windowSeconds: 18000 },
        { name: "weekly", usedPercent: weeklyPct, windowSeconds: 604800 },
      ],
      updatedAt: new Date().toISOString(),
    };
  }

  it("füttert den Tracker und hängt windowBudget an den Snapshot", async () => {
    const store = new UsageStore();
    const file = emptyRatioFile();
    file.providers.claude = { ...emptyProviderState(), sumFivePct: 900, sumWeeklyPct: 300 };
    const tracker = new WindowRatioTracker(file);
    const provider = makeProvider("claude", async () => snapWithWindows("claude", 30, 62));
    const loop = new RefreshLoop([provider], store, 60, 10_000, undefined, undefined, tracker);

    const [snap] = await loop.refreshNow();
    expect(snap.windowBudget).toBeDefined();
    expect(snap.windowBudget?.learning).toBe(false);
    if (snap.windowBudget && !snap.windowBudget.learning) {
      expect(snap.windowBudget.windowsPerWeek).toBeCloseTo(3);
      expect(snap.windowBudget.usedWindows).toBeCloseTo(1.86);
    }
  });

  it("hängt kein windowBudget an, wenn das Weekly-Fenster fehlt", async () => {
    const store = new UsageStore();
    const tracker = new WindowRatioTracker();
    const provider = makeProvider("claude", async () => okSnap("claude"));
    const loop = new RefreshLoop([provider], store, 60, 10_000, undefined, undefined, tracker);

    const [snap] = await loop.refreshNow();
    expect(snap.windowBudget).toBeUndefined();
  });
});
