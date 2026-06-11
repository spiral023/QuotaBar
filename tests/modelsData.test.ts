// tests/modelsData.test.ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { buildModelsData } from "../src/main/modelsData";
import { defaultSettings } from "../src/config/settings";
import type { BackfillDayRecord } from "../src/reports/types";

const SETTINGS = { ...defaultSettings, pricingOfflineMode: true };
const BENCHMARKS_FILE = path.join(__dirname, "..", "src", "config", "model-benchmarks.json");

function record(
  date: string,
  provider: "claude" | "codex",
  perModel: BackfillDayRecord["perModel"],
): BackfillDayRecord {
  const totals = Object.values(perModel).reduce(
    (acc, m) => ({
      inputTokens: acc.inputTokens + m.inputTokens,
      outputTokens: acc.outputTokens + m.outputTokens,
      cacheCreationTokens: acc.cacheCreationTokens + m.cacheCreationTokens,
      cacheReadTokens: acc.cacheReadTokens + m.cacheReadTokens,
      totalTokens: acc.totalTokens + m.totalTokens,
      costUSD: acc.costUSD + m.costUSD,
    }),
    { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, costUSD: 0 },
  );
  return { date, provider, ...totals, sessionCount: 1, models: Object.keys(perModel), perModel };
}

const PM = (input: number, output: number, costUSD: number) => ({
  inputTokens: input, outputTokens: output,
  cacheCreationTokens: 0, cacheReadTokens: 0,
  totalTokens: input + output, costUSD,
});

describe("buildModelsData — backfill aggregation", () => {
  it("emits one ModelDay per date/provider/model", async () => {
    const data = await buildModelsData({
      settings: SETTINGS,
      benchmarksFile: BENCHMARKS_FILE,
      backfillRecords: [
        record("2026-01-01", "claude", { "claude-opus-4-8": PM(100, 50, 1.5) }),
        record("2026-01-01", "codex",  { "gpt-5.5": PM(200, 80, 0.9) }),
        record("2026-01-02", "claude", { "claude-opus-4-8": PM(10, 5, 0.2) }),
      ],
      claudeEntries: [],
      codexEvents: [],
    });
    expect(data.days).toHaveLength(3);
    const d1 = data.days.find(d => d.date === "2026-01-01" && d.provider === "claude");
    expect(d1?.model).toBe("claude-opus-4-8");
    expect(d1?.costUSD).toBeCloseTo(1.5);
  });

  it("normalizes model names and merges entries that collapse to the same name", async () => {
    const data = await buildModelsData({
      settings: SETTINGS,
      benchmarksFile: BENCHMARKS_FILE,
      backfillRecords: [
        record("2026-01-01", "claude", {
          "claude-haiku-4-5-20251001": PM(100, 10, 0.1),
          "claude-haiku-4-5":          PM(50, 5, 0.05),
        }),
      ],
      claudeEntries: [],
      codexEvents: [],
    });
    expect(data.days).toHaveLength(1);
    expect(data.days[0].model).toBe("claude-haiku-4-5");
    expect(data.days[0].inputTokens).toBe(150);
    expect(data.days[0].costUSD).toBeCloseTo(0.15);
  });

  it("filters synthetic and unknown models", async () => {
    const data = await buildModelsData({
      settings: SETTINGS,
      benchmarksFile: BENCHMARKS_FILE,
      backfillRecords: [
        record("2026-01-01", "claude", {
          "<synthetic>": PM(5, 1, 0),
          "unknown":     PM(5, 1, 0),
          "claude-opus-4-8": PM(100, 50, 1.0),
        }),
      ],
      claudeEntries: [],
      codexEvents: [],
    });
    expect(data.days).toHaveLength(1);
    expect(data.days[0].model).toBe("claude-opus-4-8");
  });

  it("days are sorted by date ascending", async () => {
    const data = await buildModelsData({
      settings: SETTINGS,
      benchmarksFile: BENCHMARKS_FILE,
      backfillRecords: [
        record("2026-01-03", "claude", { "claude-opus-4-8": PM(1, 1, 0.1) }),
        record("2026-01-01", "claude", { "claude-opus-4-8": PM(1, 1, 0.1) }),
      ],
      claudeEntries: [],
      codexEvents: [],
    });
    expect(data.days.map(d => d.date)).toEqual(["2026-01-01", "2026-01-03"]);
  });
});
