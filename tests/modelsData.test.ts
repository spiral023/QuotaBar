// tests/modelsData.test.ts
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildModelsData } from "../src/main/modelsData";
import { defaultSettings } from "../src/config/settings";
import type { BackfillDayRecord } from "../src/reports/types";
import type { ClaudeUsageEntry } from "../src/pricing/jsonl-reader";
import type { CodexTokenEvent } from "../src/pricing/codex-log-reader";

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

function claudeEntry(isoTs: string, model: string, output: number): ClaudeUsageEntry {
  return {
    provider: "claude", timestamp: isoTs, model,
    project: "p", session: "s",
    inputTokens: 10, outputTokens: output, cacheCreationTokens: 0, cacheReadTokens: 0,
    costUSD: 0.5,
  };
}

function codexEvent(isoTs: string, model: string, output: number): CodexTokenEvent {
  return {
    timestamp: isoTs, model, isFallback: false, session: "s", directory: ".",
    inputTokens: 10, cachedInputTokens: 0, outputTokens: output,
    reasoningOutputTokens: 0, totalTokens: 10 + output,
  };
}

describe("buildModelsData — live tail merge", () => {
  it("adds live days strictly after the provider's last backfill date", async () => {
    const data = await buildModelsData({
      settings: SETTINGS,
      benchmarksFile: BENCHMARKS_FILE,
      backfillRecords: [
        record("2026-01-10", "claude", { "claude-opus-4-8": PM(100, 50, 1.0) }),
      ],
      claudeEntries: [
        claudeEntry("2026-01-10T12:00:00.000Z", "claude-opus-4-8", 99),  // selber Tag → ignoriert
        claudeEntry("2026-01-11T12:00:00.000Z", "claude-opus-4-8", 42),  // danach → übernommen
      ],
      codexEvents: [],
    });
    const backfillDay = data.days.find(d => d.date === "2026-01-10");
    expect(backfillDay?.outputTokens).toBe(50); // unverändert, kein Doppelzählen
    const liveDay = data.days.find(d => d.date === "2026-01-11");
    expect(liveDay?.outputTokens).toBe(42);
  });

  it("falls back to live-only when a provider has no backfill records", async () => {
    const data = await buildModelsData({
      settings: SETTINGS,
      benchmarksFile: BENCHMARKS_FILE,
      backfillRecords: [],
      claudeEntries: [claudeEntry("2026-01-05T08:00:00.000Z", "claude-sonnet-4-6", 7)],
      codexEvents: [codexEvent("2026-01-06T08:00:00.000Z", "gpt-5.5", 11)],
    });
    expect(data.days.find(d => d.provider === "claude")?.date).toBe("2026-01-05");
    expect(data.days.find(d => d.provider === "codex")?.date).toBe("2026-01-06");
  });

  it("normalizes live model names too", async () => {
    const data = await buildModelsData({
      settings: SETTINGS,
      benchmarksFile: BENCHMARKS_FILE,
      backfillRecords: [],
      claudeEntries: [claudeEntry("2026-01-05T08:00:00.000Z", "claude-haiku-4-5-20251001", 3)],
      codexEvents: [],
    });
    expect(data.days[0].model).toBe("claude-haiku-4-5");
  });
});

describe("buildModelsData — pricing & benchmarks", () => {
  it("includes per-model pricing rates from offline fallback prices", async () => {
    const data = await buildModelsData({
      settings: SETTINGS, // pricingOfflineMode: true → deterministische FALLBACK_PRICES
      benchmarksFile: BENCHMARKS_FILE,
      backfillRecords: [record("2026-01-01", "claude", { "claude-haiku-4-5": PM(10, 5, 0.01) })],
      claudeEntries: [],
      codexEvents: [],
    });
    const rate = data.pricing["claude-haiku-4-5"];
    expect(rate).toBeDefined();
    expect(rate.inputPerMTok).toBeCloseTo(0.8);      // 8e-7 × 1e6
    expect(rate.cacheReadPerMTok).toBeCloseTo(0.08); // 8e-8 × 1e6
  });

  it("exposes benchmark scores with asOf", async () => {
    const data = await buildModelsData({
      settings: SETTINGS,
      benchmarksFile: BENCHMARKS_FILE,
      backfillRecords: [],
      claudeEntries: [],
      codexEvents: [],
    });
    // Gegen die gepflegte JSON prüfen statt einen festen Score zu pinnen — Scores
    // werden regelmäßig aktualisiert; der Test verifiziert das Durchreichen, nicht den Wert.
    const fileScores = (JSON.parse(fs.readFileSync(BENCHMARKS_FILE, "utf8")) as { scores: Record<string, number> }).scores;
    expect(data.benchmarks["claude-opus-4-8"]).toBe(fileScores["claude-opus-4-8"]);
    expect(data.benchmarksAsOf).toMatch(/^\d{4}-\d{2}(-\d{2})?$/);
  });

  it("returns empty benchmarks when the file is missing (spec error case)", async () => {
    const data = await buildModelsData({
      settings: SETTINGS,
      benchmarksFile: path.join(__dirname, "does-not-exist.json"),
      backfillRecords: [],
      claudeEntries: [],
      codexEvents: [],
    });
    expect(data.benchmarks).toEqual({});
    expect(data.benchmarksAsOf).toBe("");
  });
});
