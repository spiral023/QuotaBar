import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PricingEngine } from "../src/pricing/subscription-factor";
import type { Settings } from "../src/config/settings";
import type { ModelPricing } from "../src/pricing/cost-calculator";
import { HistoricalPricingResolver } from "../src/pricing/historical-pricing-resolver";
import type { UsageSnapshot } from "../src/providers/types";

const settings: Settings = {
  pollIntervalSeconds: 60,
  providerTimeoutMs: 10_000,
  plans: [
    { id: "claude-pro", provider: "claude", name: "Pro", amount: 20, currency: "USD", startsAt: "2020-01-01T00:00:00.000Z", endsAt: null },
    { id: "codex-team", provider: "codex",  name: "Team", amount: 10, currency: "USD", startsAt: "2020-01-01T00:00:00.000Z", endsAt: null },
  ],
  pricingOfflineMode: true,
  costWindow: "billing",
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

function daysInCurrentLocalMonth(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
}

describe("PricingEngine", () => {
  it("uses historical Claude price epochs for the Cost Factor", async () => {
    const claudeDir = path.join(os.tmpdir(), `quotabar-sf-historical-${Date.now()}`);
    const historyPath = path.join(claudeDir, "pricing-history.json");
    const model = "historical-claude";
    let current: ModelPricing = { output_cost_per_token: 4e-6 };
    let now = new Date("2026-05-01T00:00:00.000Z");
    const resolver = new HistoricalPricingResolver({ getModelPricing: async () => current }, {
      historyPath,
      now: () => now,
    });
    await resolver.getModelPricing(model);
    current = { output_cost_per_token: 2e-6 };
    now = new Date("2026-06-01T00:00:00.000Z");
    await resolver.getModelPricing(model);
    await fs.mkdir(path.join(claudeDir, "project"), { recursive: true });
    await fs.writeFile(path.join(claudeDir, "project", "session.jsonl"), [
      JSON.stringify({ timestamp: "2026-05-02T12:00:00.000Z", message: { id: "may", model, usage: { output_tokens: 1_000_000 } } }),
      JSON.stringify({ timestamp: "2026-06-02T12:00:00.000Z", message: { id: "june", model, usage: { output_tokens: 1_000_000 } } }),
    ].join("\n") + "\n", "utf8");

    try {
      const engine = new PricingEngine({ ...settings, costWindow: "all" }, claudeDir, undefined, undefined, undefined, { pricingResolver: resolver });
      const result = await engine.calculateFactor(makeSnapshot("claude"));
      expect(result!.apiCostUSD).toBeCloseTo(6, 6);
      expect(result!.isEstimate).toBe(false);
    } finally {
      await fs.rm(claudeDir, { recursive: true, force: true });
    }
  });

  it("prices model-less Claude fallback entries at each event timestamp", async () => {
    const claudeDir = path.join(os.tmpdir(), `quotabar-sf-fallback-epochs-${Date.now()}`);
    const historyPath = path.join(claudeDir, "pricing-history.json");
    const model = "fallback-priced";
    let current: ModelPricing = { output_cost_per_token: 4e-6 };
    let now = new Date("2026-05-01T00:00:00.000Z");
    const resolver = new HistoricalPricingResolver({ getModelPricing: async () => current }, { historyPath, now: () => now });
    await resolver.getModelPricing(model);
    current = { output_cost_per_token: 2e-6 };
    now = new Date("2026-06-01T00:00:00.000Z");
    await resolver.getModelPricing(model);
    await fs.mkdir(path.join(claudeDir, "project"), { recursive: true });
    await fs.writeFile(path.join(claudeDir, "project", "session.jsonl"), [
      JSON.stringify({ timestamp: "2026-05-02T12:00:00.000Z", message: { id: "may", usage: { output_tokens: 1_000_000 } } }),
      JSON.stringify({ timestamp: "2026-06-02T12:00:00.000Z", message: { id: "june", usage: { output_tokens: 1_000_000 } } }),
    ].join("\n") + "\n", "utf8");

    try {
      const engine = new PricingEngine({ ...settings, costWindow: "all" }, claudeDir, undefined, undefined, undefined, { pricingResolver: resolver });
      const result = await engine.calculateFactor(makeSnapshot("claude", { model }));
      expect(result!.apiCostUSD).toBeCloseTo(6, 6);
    } finally {
      await fs.rm(claudeDir, { recursive: true, force: true });
    }
  });

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
    // No entries means sinceDay = untilDay = today, so the plan window is a single day.
    // Monthly plan cost is prorated by the number of days in the current local month.
    expect(result!.apiCostUSD).toBe(0);
    expect(result!.isEstimate).toBe(false);
    expect(result!.factor).toBe(0);
    expect(result!.subscriptionCostUSD).toBeCloseTo(20 / daysInCurrentLocalMonth(), 6);
  });

  it("returns Keine Logs for Codex when sessions dir is empty", async () => {
    const engine = new PricingEngine(settings, "/nonexistent/claude", "/nonexistent/codex", "/nonexistent/config.toml");
    const result = await engine.calculateFactor(makeSnapshot("codex"));
    expect(result).not.toBeUndefined();
    expect(result!.factor).toBeNull();
    expect(result!.isEstimate).toBe(true);
    expect(result!.label).toBe("Keine Logs verfügbar");
    expect(result!.apiCostUSD).toBe(0);
    // No logs → early return with subscriptionCostUSD 0 and factor null.
    expect(result!.subscriptionCostUSD).toBe(0);
  });

  it("returns real cost for Codex when JSONL events exist", async () => {
    const resetsAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    const billingStart = new Date(resetsAt.getTime() - 7 * 24 * 3600 * 1000);
    const eventTime = new Date(billingStart.getTime() + 1000).toISOString(); // 1 second after billing start

    // Build a session directory path matching the billing start date
    const year = billingStart.getUTCFullYear();
    const month = String(billingStart.getUTCMonth() + 1).padStart(2, "0");
    const day = String(billingStart.getUTCDate()).padStart(2, "0");

    const sessionsDir = path.join(os.tmpdir(), `quotabar-sf-test-${Date.now()}`);
    const sessionFile = path.join(sessionsDir, `${year}/${month}/${day}`);
    await fs.mkdir(sessionFile, { recursive: true });
    await fs.writeFile(
      path.join(sessionFile, "session.jsonl"),
      [
        JSON.stringify({ timestamp: eventTime, type: "turn_context", payload: { model: "gpt-4o" } }),
        JSON.stringify({
          timestamp: new Date(billingStart.getTime() + 2000).toISOString(), // 2 seconds after billing start
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 0, total_tokens: 1100 },
              total_token_usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 0, total_tokens: 1100 },
            },
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    try {
      const engine = new PricingEngine(settings, "/nonexistent/claude", sessionsDir, "/nonexistent/config.toml");
      const snapshot = makeSnapshot("codex", {
        windows: [{ name: "weekly", usedPercent: 5, resetsAt: resetsAt.toISOString() }],
      });
      const result = await engine.calculateFactor(snapshot);
      expect(result).not.toBeUndefined();
      expect(result!.factor).not.toBeNull();
      expect(result!.isEstimate).toBe(false);
      expect(result!.apiCostUSD).toBeGreaterThan(0);
      // Events are near now, so sinceDay = untilDay = today (single day).
      // Monthly plan cost is prorated by the number of days in the current local month.
      expect(result!.subscriptionCostUSD).toBeCloseTo(10 / daysInCurrentLocalMonth(), 6);
    } finally {
      await fs.rm(sessionsDir, { recursive: true, force: true });
    }
  });

  it("label has no ~ prefix for exact Claude result", async () => {
    const engine = new PricingEngine(settings, "/nonexistent/path");
    const result = await engine.calculateFactor(makeSnapshot("claude"));
    expect(result!.label).not.toMatch(/^~/);
  });

  it("calculates Claude cost per model separately (haiku + sonnet)", async () => {
    const claudeDir = path.join(os.tmpdir(), `quotabar-sf-claude-multimodel-${Date.now()}`);
    const projectDir = path.join(claudeDir, "proj1");
    await fs.mkdir(projectDir, { recursive: true });
    const billingStart = new Date("2026-05-01T00:00:00.000Z");
    await fs.writeFile(
      path.join(projectDir, "session.jsonl"),
      [
        // haiku entry: cache_read dominant (cheap)
        JSON.stringify({
          timestamp: "2026-05-10T10:00:00.000Z",
          message: { id: "msg_h1", model: "claude-haiku-4-5", usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 } },
        }),
        // sonnet entry: cache_read dominant (expensive, 3.75× haiku)
        JSON.stringify({
          timestamp: "2026-05-10T10:01:00.000Z",
          message: { id: "msg_s1", model: "claude-sonnet-4-5", usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 } },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    try {
      const engine = new PricingEngine(settings, claudeDir);
      const result = await engine.calculateFactor(makeSnapshot("claude", {
        windows: [{ name: "credits", resetsAt: billingStart.toISOString() }],
      }));

      expect(result).not.toBeUndefined();
      expect(result!.apiCostUSD).toBeGreaterThan(0);

      // haiku cache_read: 1M × $0.08/M = $0.08
      // sonnet cache_read: 1M × $0.30/M = $0.30
      // total: $0.38
      // Using only haiku pricing for both would give $0.16 (too low)
      // Using only sonnet pricing for both would give $0.60 (too high)
      expect(result!.apiCostUSD).toBeCloseTo(0.08 + 0.30, 2);
    } finally {
      await fs.rm(claudeDir, { recursive: true, force: true });
    }
  });

  it("includes windowLabel in CostFactorResult", async () => {
    const engine = new PricingEngine({ ...settings, costWindow: "7d" }, "/nonexistent/path");
    const result = await engine.calculateFactor(makeSnapshot("claude"));
    expect(result).not.toBeUndefined();
    expect(result!.windowLabel).toBe("7d");
  });

  it("Claude 7d: billingStart ist 7 Tage vor jetzt (näherungsweise)", async () => {
    const claudeDir = path.join(os.tmpdir(), `qb-sf-7d-${Date.now()}`);
    const projectDir = path.join(claudeDir, "proj1");
    await fs.mkdir(projectDir, { recursive: true });
    const recentTs = new Date(Date.now() - 1000).toISOString();
    const oldTs = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    await fs.writeFile(
      path.join(projectDir, "session.jsonl"),
      [
        JSON.stringify({ timestamp: recentTs, message: { id: "msg_r1", model: "claude-haiku-4-5", usage: { output_tokens: 1000 } } }),
        JSON.stringify({ timestamp: oldTs,    message: { id: "msg_o1", model: "claude-haiku-4-5", usage: { output_tokens: 9999 } } }),
      ].join("\n") + "\n",
      "utf8",
    );
    try {
      const engine = new PricingEngine({ ...settings, costWindow: "7d" }, claudeDir);
      const result = await engine.calculateFactor(makeSnapshot("claude"));
      expect(result!.windowLabel).toBe("7d");
      // Nur recentTs-Token sollen zählen — output 1000 tokens haiku = $0.004
      expect(result!.apiCostUSD).toBeCloseTo(1000 * 4e-6, 5);
    } finally {
      await fs.rm(claudeDir, { recursive: true, force: true });
    }
  });

  it("Claude 30d: billingStart ist 30 Tage vor jetzt", async () => {
    const claudeDir = path.join(os.tmpdir(), `qb-sf-30d-${Date.now()}`);
    const projectDir = path.join(claudeDir, "proj1");
    await fs.mkdir(projectDir, { recursive: true });
    const ts20d = new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString();
    await fs.writeFile(
      path.join(projectDir, "session.jsonl"),
      [JSON.stringify({ timestamp: ts20d, message: { id: "msg_20d", model: "claude-haiku-4-5", usage: { output_tokens: 500 } } })].join("\n") + "\n",
      "utf8",
    );
    try {
      const engine = new PricingEngine({ ...settings, costWindow: "30d" }, claudeDir);
      const result = await engine.calculateFactor(makeSnapshot("claude"));
      expect(result!.windowLabel).toBe("30d");
      expect(result!.apiCostUSD).toBeCloseTo(500 * 4e-6, 5);
    } finally {
      await fs.rm(claudeDir, { recursive: true, force: true });
    }
  });

  it("listet Modelle ohne Preis in missingPricingModels und zählt deren Tokens nicht", async () => {
    const claudeDir = path.join(os.tmpdir(), `qb-sf-missing-${Date.now()}`);
    const projectDir = path.join(claudeDir, "proj1");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, "session.jsonl"),
      [JSON.stringify({ timestamp: new Date().toISOString(), message: { id: "msg_x", model: "zzz-unpriced-9000", usage: { output_tokens: 1000 } } })].join("\n") + "\n",
      "utf8",
    );
    try {
      const engine = new PricingEngine(settings, claudeDir);
      const result = await engine.calculateFactor(makeSnapshot("claude"));
      expect(result!.missingPricingModels).toContain("zzz-unpriced-9000");
      expect(result!.apiCostUSD).toBe(0);
    } finally {
      await fs.rm(claudeDir, { recursive: true, force: true });
    }
  });
});
