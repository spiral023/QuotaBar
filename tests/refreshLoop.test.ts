import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitError } from "../src/shared/errors";
import type { UsageProvider, UsageSnapshot } from "../src/providers/types";
import { RefreshLoop } from "../src/usage/refreshLoop";
import { UsageStore } from "../src/usage/usageStore";

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
  });

  afterEach(() => {
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
