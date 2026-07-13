import { describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../src/config/settings";
import { fromClaudeEntries, fromCodexEvents } from "../src/portable/eventAdapters";
import { runAnalyticsTask } from "../src/main/analyticsWorker";

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
});
