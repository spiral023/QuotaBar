import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../src/config/settings";
import { fromClaudeEntries, fromCodexEvents } from "../src/portable/eventAdapters";
import { buildModelsData } from "../src/main/modelsData";
import { runAnalyticsTask } from "../src/main/analyticsWorker";

vi.mock("../src/portable/quotaStore", () => ({
  readQuotaSnapshots: vi.fn(async () => [{
    kind: "snapshot", provider: "claude", status: "ok", fetchedAt: "2026-07-10T12:00:00.000Z",
    windows: [{ name: "five_hour", usedPercent: 40, resetsAt: "2026-07-10T15:00:00.000Z" }],
  }]),
}));

const settings = { ...defaultSettings, pricingOfflineMode: true, plans: [] };
const events = [
  ...fromClaudeEntries([
    { provider: "claude" as const, timestamp: "2026-07-10T10:00:00.000Z", model: "claude-haiku-4-5-20251001", project: "/secret/alpha", projectName: "alpha", session: "raw-a", inputTokens: 100, outputTokens: 20, cacheCreationTokens: 10, cacheReadTokens: 30, costUSD: 1.25, inputCostUSD: .5, outputCostUSD: .4, cacheCreationCostUSD: .2, cacheReadCostUSD: .15 },
    { provider: "claude" as const, timestamp: "2026-07-10T10:30:00.000Z", model: "claude-haiku-4-5-20251001", project: "/secret/alpha", projectName: "alpha", session: "raw-a", inputTokens: 50, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 20, costUSD: .75 },
    { provider: "claude" as const, timestamp: "2026-07-11T09:00:00.000Z", model: "claude-opus-4-8", project: "/secret/beta", projectName: "beta", session: "raw-b", inputTokens: 200, outputTokens: 40, cacheCreationTokens: 0, cacheReadTokens: 50, costUSD: 2 },
  ]),
  ...fromCodexEvents([
    { timestamp: "2026-07-10T11:00:00.000Z", model: "gpt-5.5", isFallback: false, session: "raw-x", directory: "/secret/gamma", projectName: "gamma", inputTokens: 300, cachedInputTokens: 100, outputTokens: 60, reasoningOutputTokens: 15, totalTokens: 360, costUSD: 3, inputCostUSD: 1, outputCostUSD: 1.5, cacheReadCostUSD: .5 },
    { timestamp: "2026-07-10T12:00:00.000Z", model: "gpt-5.5", isFallback: false, session: "raw-x", directory: "/secret/gamma", projectName: "gamma", inputTokens: 120, cachedInputTokens: 20, outputTokens: 30, reasoningOutputTokens: 5, totalTokens: 150, costUSD: 1 },
    { timestamp: "2026-07-12T08:00:00.000Z", model: "gpt-5.6", isFallback: false, session: "raw-y", directory: "/secret/delta", projectName: "delta", inputTokens: 80, cachedInputTokens: 0, outputTokens: 25, reasoningOutputTokens: 8, totalTokens: 105, costUSD: .8 },
  ]),
];

describe("portable models and analytics parity", () => {
  it("aggregates UTC model days with authoritative stored costs and components", async () => {
    const data = await buildModelsData({ settings, usageEvents: events, benchmarksFile: path.join(__dirname, "..", "src", "config", "model-benchmarks.json") });
    expect(data.days.map(({ date, provider, model, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, costUSD }) =>
      ({ date, provider, model, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, costUSD }))).toEqual([
      { date: "2026-07-10", provider: "claude", model: "claude-haiku-4-5", inputTokens: 150, outputTokens: 30, cacheCreationTokens: 10, cacheReadTokens: 50, costUSD: 2 },
      { date: "2026-07-10", provider: "codex", model: "gpt-5.5", inputTokens: 300, outputTokens: 90, cacheCreationTokens: 0, cacheReadTokens: 120, costUSD: 4 },
      { date: "2026-07-11", provider: "claude", model: "claude-opus-4-8", inputTokens: 200, outputTokens: 40, cacheCreationTokens: 0, cacheReadTokens: 50, costUSD: 2 },
      { date: "2026-07-12", provider: "codex", model: "gpt-5.6", inputTokens: 80, outputTokens: 25, cacheCreationTokens: 0, cacheReadTokens: 0, costUSD: .8 },
    ]);
    expect(data.days[0].inputCostUSD).toBe(.5);
    expect(data.days[0].cacheReadCostUSD).toBe(.15);
  });

  it("preserves API costs, active days, sessions, heatmap, cache, models and project stats", async () => {
    const result = await runAnalyticsTask({ task: "get", periodStartMs: Date.parse("2026-07-10T00:00:00Z"), windowDays: 3, since: "2026-07-10", until: "2026-07-12", settings, cacheHitRate: { claude: 40, codex: 28.57 }, nowMs: Date.parse("2026-07-12T23:59:59.999Z") }, { usageEvents: events });
    expect(result).toMatchObject({ apiCostUSD: { claude: 4, codex: 4.8, total: 8.8 }, activeDays: 3, cacheHitRate: { claude: 40, codex: 28.57 } });
    if (!("sessionStats" in result)) throw new Error("expected analytics data");
    expect(result.sessionStats.claude).toMatchObject({ count: 2, avgMinutes: 30 });
    expect(result.sessionStats.codex).toMatchObject({ count: 2, avgMinutes: 60 });
    expect(result.hourHeatmap.all.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(6);
    expect(result.topModels.map(({ model }) => model)).toEqual(expect.arrayContaining(["gpt-5.5", "claude-haiku-4-5"]));
    expect(JSON.stringify(result)).not.toContain("/secret/");
    expect(JSON.stringify(result)).not.toContain("raw-");
    expect(result.fiveHourPressure.claude.total).toBeGreaterThanOrEqual(0);
  });

  it("keeps provider and backfill readers out of modelsData and analytics worker", () => {
    for (const file of ["modelsData.ts", "analyticsWorker.ts"]) {
      const source = fs.readFileSync(path.join(__dirname, "..", "src", "main", file), "utf8");
      expect(source).not.toMatch(/(?:jsonl-reader|codex-log-reader|backfill-reader)/);
      expect(source).not.toContain('source: "legacy"');
    }
  });
});
