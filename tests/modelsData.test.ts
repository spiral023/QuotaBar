import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../src/config/settings";
import { buildModelsData } from "../src/main/modelsData";
import { fromClaudeEntries, fromCodexEvents } from "../src/portable/eventAdapters";
import { PortableUsageStore } from "../src/portable/usageStore";

const settings = { ...defaultSettings, pricingOfflineMode: true };
const benchmarksFile = path.join(__dirname, "..", "src", "config", "model-benchmarks.json");

describe("buildModelsData portable aggregation", () => {
  it("reads an explicitly bounded portable range and never needs provider history", async () => {
    const store = new PortableUsageStore("unused");
    const read = vi.spyOn(store, "read").mockResolvedValue([]);
    await buildModelsData({ settings, usageStore: store, usageRange: { since: "2026-01-01T00:00:00.000Z", until: "2026-01-31T23:59:59.999Z" }, benchmarksFile });
    expect(read).toHaveBeenCalledWith({ since: "2026-01-01T00:00:00.000Z", until: "2026-01-31T23:59:59.999Z" });
  });

  it("normalizes models, filters internal models and sorts UTC provider days", async () => {
    const usageEvents = [
      ...fromClaudeEntries([
        { provider: "claude" as const, timestamp: "2026-01-03T08:00:00.000Z", model: "claude-haiku-4-5-20251001", project: "p", session: "s", inputTokens: 10, outputTokens: 2, cacheCreationTokens: 1, cacheReadTokens: 3, costUSD: .4 },
        { provider: "claude" as const, timestamp: "2026-01-03T09:00:00.000Z", model: "claude-haiku-4-5", project: "p", session: "s", inputTokens: 5, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 2, costUSD: .1 },
        { provider: "claude" as const, timestamp: "2026-01-01T09:00:00.000Z", model: "unknown", project: "p", session: "s", inputTokens: 999, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 },
      ]),
      ...fromCodexEvents([{ timestamp: "2026-01-02T08:00:00.000Z", model: "gpt-5.5", isFallback: false, session: "x", directory: ".", inputTokens: 20, cachedInputTokens: 4, outputTokens: 5, reasoningOutputTokens: 2, totalTokens: 25, costUSD: .8 }]),
    ];
    const data = await buildModelsData({ settings, usageEvents, benchmarksFile });
    expect(data.days.map(({ date, provider, model }) => ({ date, provider, model }))).toEqual([
      { date: "2026-01-02", provider: "codex", model: "gpt-5.5" },
      { date: "2026-01-03", provider: "claude", model: "claude-haiku-4-5" },
    ]);
    expect(data.days[1]).toMatchObject({ inputTokens: 15, outputTokens: 3, cacheCreationTokens: 1, cacheReadTokens: 5, costUSD: .5 });
  });

  it("uses stored authoritative cost components and does not recalculate event cost", async () => {
    const usageEvents = fromClaudeEntries([{ provider: "claude", timestamp: "2026-01-01T00:00:00.000Z", model: "claude-haiku-4-5", project: "p", session: "s", inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreationTokens: 0, cacheReadTokens: 0, costUSD: 7, inputCostUSD: 1, outputCostUSD: 6 }]);
    const data = await buildModelsData({ settings, usageEvents, benchmarksFile });
    expect(data.days[0]).toMatchObject({ costUSD: 7, inputCostUSD: 1, outputCostUSD: 6 });
  });

  it("exposes benchmark indexes and offline model pricing metadata", async () => {
    const usageEvents = fromClaudeEntries([{ provider: "claude", timestamp: "2026-01-01T00:00:00.000Z", model: "claude-haiku-4-5", project: "p", session: "s", inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 }]);
    const data = await buildModelsData({ settings, usageEvents, benchmarksFile });
    const scores = (JSON.parse(fs.readFileSync(benchmarksFile, "utf8")) as { indexes: { intelligence: { scores: Record<string, number> } } }).indexes.intelligence.scores;
    expect(data.benchmarks["claude-opus-4-8"]).toBe(scores["claude-opus-4-8"]);
    expect(data.pricing["claude-haiku-4-5"].inputPerMTok).toBeCloseTo(.8);
    expect(data.pricing["claude-haiku-4-5"].cacheReadPerMTok).toBeCloseTo(.08);
  });

  it("returns empty benchmarks for a missing file", async () => {
    const data = await buildModelsData({ settings, usageEvents: [], benchmarksFile: path.join(__dirname, "missing.json") });
    expect(data.benchmarks).toEqual({});
    expect(data.benchmarksAsOf).toBe("");
  });
});
