import { describe, expect, it } from "vitest";
import { PricingEngine } from "../src/pricing/subscription-factor";
import type { Settings } from "../src/config/settings";
import type { UsageSnapshot } from "../src/providers/types";

const settings: Settings = {
  pollIntervalSeconds: 60,
  providerTimeoutMs: 10_000,
  subscriptionCosts: { claude: 20, codex: 10, gemini: 19 },
  pricingOfflineMode: true,
};

function makeSnapshot(provider: string, overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    provider,
    status: "ok",
    windows: [],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("PricingEngine", () => {
  it("returns undefined for error snapshots", async () => {
    const engine = new PricingEngine(settings, "/nonexistent/path");
    expect(await engine.calculateFactor(makeSnapshot("claude", { status: "error" }))).toBeUndefined();
  });

  it("returns undefined for not_authenticated snapshots", async () => {
    const engine = new PricingEngine(settings, "/nonexistent/path");
    expect(await engine.calculateFactor(makeSnapshot("claude", { status: "not_authenticated" }))).toBeUndefined();
  });

  it("returns zero cost for Claude when no JSONL dir exists", async () => {
    const engine = new PricingEngine(settings, "/nonexistent/path");
    const result = await engine.calculateFactor(makeSnapshot("claude"));
    expect(result).toMatchObject({
      apiCostUSD: 0,
      subscriptionCostUSD: 20,
      factor: 0,
      isEstimate: false,
    });
  });

  it("returns estimate for Codex with usedPercent", async () => {
    const engine = new PricingEngine(settings, "/nonexistent/path");
    const snapshot = makeSnapshot("codex", {
      windows: [{ name: "fiveHour", usedPercent: 50 }],
    });
    const result = await engine.calculateFactor(snapshot);
    expect(result).not.toBeUndefined();
    expect(result!.isEstimate).toBe(true);
    expect(result!.subscriptionCostUSD).toBe(10);
    expect(result!.apiCostUSD).toBeGreaterThan(0);
  });

  it("returns undefined for Codex when no usedPercent available", async () => {
    const engine = new PricingEngine(settings, "/nonexistent/path");
    const result = await engine.calculateFactor(makeSnapshot("codex", { windows: [] }));
    expect(result).toBeUndefined();
  });

  it("returns estimate for Gemini with label containing session count", async () => {
    const engine = new PricingEngine(settings, "/nonexistent/path");
    const snapshot = makeSnapshot("gemini", {
      windows: [{ name: "session", label: "5 sessions (gemini-2.0-flash)" }],
    });
    const result = await engine.calculateFactor(snapshot);
    expect(result).not.toBeUndefined();
    expect(result!.isEstimate).toBe(true);
    expect(result!.subscriptionCostUSD).toBe(19);
  });

  it("label uses ~ prefix for estimates", async () => {
    const engine = new PricingEngine(settings, "/nonexistent/path");
    const snapshot = makeSnapshot("codex", {
      windows: [{ name: "fiveHour", usedPercent: 60 }],
    });
    const result = await engine.calculateFactor(snapshot);
    expect(result!.label).toMatch(/^~/);
  });

  it("label has no ~ prefix for exact Claude result", async () => {
    const engine = new PricingEngine(settings, "/nonexistent/path");
    const result = await engine.calculateFactor(makeSnapshot("claude"));
    expect(result!.label).not.toMatch(/^~/);
  });
});
