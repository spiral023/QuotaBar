import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../src/config/settings";
import { fromClaudeEntries, fromCodexEvents } from "../src/portable/eventAdapters";
import { PortableUsageStore } from "../src/portable/usageStore";
import { runAnalyticsTask } from "../src/main/analyticsWorker";

vi.mock("../src/portable/quotaStore", () => ({
  readQuotaSnapshots: vi.fn(async () => []),
}));

afterEach(() => vi.restoreAllMocks());

describe("analytics summary portable isolation", () => {
  it("builds summary before invoking provider history readers", async () => {
    const usageEvents = [
      ...fromClaudeEntries([{
        provider: "claude", timestamp: "2026-07-10T10:00:00.000Z", model: "claude-test",
        project: "project", session: "session", inputTokens: 10, outputTokens: 5,
        cacheCreationTokens: 0, cacheReadTokens: 0, costUSD: 1,
      }]),
      ...fromCodexEvents([{
        timestamp: "2026-07-11T10:00:00.000Z", model: "codex-test", isFallback: false,
        session: "session", directory: "project", inputTokens: 20, cachedInputTokens: 5,
        outputTokens: 10, reasoningOutputTokens: 0, totalTokens: 30, costUSD: 2,
        inputCostUSD: 0.5, outputCostUSD: 1, cacheReadCostUSD: 0.5,
      }]),
    ];
    const readClaudeEntries = vi.fn(async () => { throw new Error("Claude history read"); });
    const readCodexEvents = vi.fn(async () => { throw new Error("Codex history read"); });

    const summary = await runAnalyticsTask({
      task: "summary",
      periodStartMs: Date.parse("2026-07-01T00:00:00.000Z"),
      periodEndMs: Date.parse("2026-07-31T23:59:59.999Z"),
      windowDays: 30,
      since: "2026-07-01",
      until: "2026-07-31",
      settings: { ...defaultSettings, pricingOfflineMode: true },
      cacheHitRate: { claude: 0, codex: 0 },
      nowMs: Date.parse("2026-07-31T23:59:59.999Z"),
    }, { usageEvents, readClaudeEntries, readCodexEvents });

    expect(summary.apiCostUSD).toEqual({ claude: 1, codex: 2, total: 3 });
    expect(readClaudeEntries).not.toHaveBeenCalled();
    expect(readCodexEvents).not.toHaveBeenCalled();
  });

  it("bounds store reads and excludes future events from all summary metrics", async () => {
    const usageEvents = fromClaudeEntries([
      {
        provider: "claude", timestamp: "2026-07-10T10:00:00.000Z", model: "claude-test",
        project: "project", session: "session", inputTokens: 1, outputTokens: 1,
        cacheCreationTokens: 0, cacheReadTokens: 0, costUSD: 0.5,
      },
      {
        provider: "claude", timestamp: "2026-07-10T11:00:00.000Z", model: "claude-test",
        project: "project", session: "session", inputTokens: 1, outputTokens: 1,
        cacheCreationTokens: 0, cacheReadTokens: 0, costUSD: 0.5,
      },
      {
        provider: "claude", timestamp: "2099-01-01T00:00:00.000Z", model: "future-model",
        project: "project", session: "session", inputTokens: 999, outputTokens: 999,
        cacheCreationTokens: 0, cacheReadTokens: 0, costUSD: 99,
      },
    ]);
    const store = new PortableUsageStore("unused");
    const read = vi.spyOn(store, "read").mockResolvedValue(usageEvents);
    const startMs = Date.parse("2026-07-01T00:00:00.000Z");
    const endMs = Date.parse("2026-07-31T12:00:00.000Z");

    const summary = await runAnalyticsTask({
      task: "summary",
      periodStartMs: startMs,
      periodEndMs: endMs,
      windowDays: 30,
      since: "2026-07-01",
      settings: { ...defaultSettings, pricingOfflineMode: true },
      cacheHitRate: { claude: 0, codex: 0 },
    }, { usageStore: store });

    expect(read).toHaveBeenCalledWith({
      since: new Date(startMs).toISOString(),
      until: new Date(endMs).toISOString(),
    });
    expect(summary.apiCostUSD).toEqual({ claude: 1, codex: 0, total: 1 });
    expect(summary.activeDays).toBe(1);
    expect(summary.avgSessionMinutes).toBe(60);
    expect(summary.topModels.map((model) => model.model)).not.toContain("future-model");
  });
});

describe("analytics get legacy isolation", () => {
  it("builds reports from injected legacy entries without reading the portable usage store", async () => {
    const read = vi.spyOn(PortableUsageStore.prototype, "read").mockRejectedValue(
      new Error("portable usage store must not be read"),
    );
    const readClaudeEntries = vi.fn(async () => [{
      provider: "claude" as const,
      timestamp: "2026-07-10T10:00:00.000Z",
      model: "claude-test",
      project: "project",
      session: "session",
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costUSD: 1,
    }]);
    const readCodexEvents = vi.fn(async () => []);

    const result = await runAnalyticsTask({
      task: "get",
      claudeProjectsDirs: ["injected-claude"],
      codexSessionsDirs: ["injected-codex"],
      periodStartMs: Date.parse("2026-07-01T00:00:00.000Z"),
      windowDays: 30,
      since: "2026-07-01",
      until: "2026-07-31",
      settings: { ...defaultSettings, pricingOfflineMode: true },
      cacheHitRate: { claude: 0, codex: 0 },
      logDir: "unused",
      nowMs: Date.parse("2026-07-31T23:59:59.999Z"),
    }, {
      usageStore: new PortableUsageStore("unused"),
      readClaudeEntries,
      readCodexEvents,
    });

    expect(result.apiCostUSD).toEqual({ claude: 1, codex: 0, total: 1 });
    expect(readClaudeEntries).toHaveBeenCalledOnce();
    expect(readCodexEvents).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
  });
});
