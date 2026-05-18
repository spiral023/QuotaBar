import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

  it("returns Keine Logs for Codex when sessions dir is empty", async () => {
    const engine = new PricingEngine(settings, "/nonexistent/claude", "/nonexistent/codex", "/nonexistent/config.toml");
    const result = await engine.calculateFactor(makeSnapshot("codex"));
    expect(result).not.toBeUndefined();
    expect(result!.factor).toBeNull();
    expect(result!.isEstimate).toBe(true);
    expect(result!.label).toBe("Keine Logs verfügbar");
    expect(result!.apiCostUSD).toBe(0);
    expect(result!.subscriptionCostUSD).toBe(10);
  });

  it("returns real cost for Codex when JSONL events exist", async () => {
    const sessionsDir = path.join(os.tmpdir(), `quotabar-sf-test-${Date.now()}`);
    const sessionFile = path.join(sessionsDir, "2026/05/18");
    await fs.mkdir(sessionFile, { recursive: true });
    await fs.writeFile(
      path.join(sessionFile, "session.jsonl"),
      [
        JSON.stringify({ timestamp: "2026-05-18T10:00:00.000Z", type: "turn_context", payload: { model: "gpt-4o" } }),
        JSON.stringify({
          timestamp: "2026-05-18T10:00:01.000Z",
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
        windows: [{ name: "weekly", usedPercent: 5, resetsAt: "2026-05-25T00:00:00.000Z" }],
      });
      const result = await engine.calculateFactor(snapshot);
      expect(result).not.toBeUndefined();
      expect(result!.factor).not.toBeNull();
      expect(result!.isEstimate).toBe(false);
      expect(result!.apiCostUSD).toBeGreaterThan(0);
      expect(result!.subscriptionCostUSD).toBe(10);
    } finally {
      await fs.rm(sessionsDir, { recursive: true, force: true });
    }
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

  it("label has no ~ prefix for exact Claude result", async () => {
    const engine = new PricingEngine(settings, "/nonexistent/path");
    const result = await engine.calculateFactor(makeSnapshot("claude"));
    expect(result!.label).not.toMatch(/^~/);
  });
});
