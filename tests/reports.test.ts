import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultSettings } from "../src/config/settings";
import type { ModelPricing } from "../src/pricing/cost-calculator";
import { HistoricalPricingResolver, resetHistoricalPricingResolverCacheForTests } from "../src/pricing/historical-pricing-resolver";
import { generateUsageReport } from "../src/reports/reportService";
import type { ReportRequest } from "../src/reports/types";

const tmpRoot = path.join(os.tmpdir(), `quotabar-reports-${process.pid}`);

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  resetHistoricalPricingResolverCacheForTests();
});

async function writeJsonl(filePath: string, entries: unknown[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
}

async function createHistoricalResolver(
  historyPath: string,
  model: string,
): Promise<HistoricalPricingResolver> {
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
  return resolver;
}

describe("usage reports", () => {
  it("keeps deprecated live and backfill source behavior explicit", async () => {
    const live: ReportRequest = { provider: "claude", type: "daily", timezone: "UTC", source: "live" };
    const backfill: ReportRequest = { provider: "claude", type: "daily", timezone: "UTC", source: "backfill" };
    const claudeEntries = [{
      provider: "claude" as const, timestamp: "2026-05-18T10:00:00.000Z", model: "claude-test",
      project: "project", session: "session", inputTokens: 1, outputTokens: 1,
      cacheCreationTokens: 0, cacheReadTokens: 0, costUSD: 1,
    }];
    const backfillRecords = [{
      date: "2026-05-18", provider: "claude" as const, inputTokens: 1, outputTokens: 1,
      cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 2, costUSD: 99,
      sessionCount: 1, models: ["claude-test"], perModel: {},
    }];

    const liveReport = await generateUsageReport(live, { claudeEntries, backfillRecords });
    const backfillReport = await generateUsageReport(backfill, { claudeEntries, backfillRecords });

    expect(liveReport.totals.costUSD).toBe(1);
    expect(liveReport.request.source).toBe("live");
    expect(backfillReport.totals.costUSD).toBe(99);
    expect(backfillReport.request.source).toBe("backfill");
  });
  it("uses the event-time Claude price while preserving source costs in auto mode", async () => {
    const model = "historical-claude";
    const resolver = await createHistoricalResolver(path.join(tmpRoot, "report-prices.json"), model);
    const entries = [
      { provider: "claude" as const, timestamp: "2026-05-02T12:00:00.000Z", model, project: "project", session: "may", inputTokens: 0, outputTokens: 1_000_000, cacheCreationTokens: 0, cacheReadTokens: 0 },
      { provider: "claude" as const, timestamp: "2026-06-02T12:00:00.000Z", model, project: "project", session: "june", inputTokens: 0, outputTokens: 1_000_000, cacheCreationTokens: 0, cacheReadTokens: 0 },
      { provider: "claude" as const, timestamp: "2026-06-02T13:00:00.000Z", model, project: "project", session: "source", inputTokens: 0, outputTokens: 1_000_000, cacheCreationTokens: 0, cacheReadTokens: 0, costUSD: 7 },
    ];

    const report = await generateUsageReport({
      provider: "claude", type: "daily", timezone: "UTC", order: "asc", costMode: "auto",
      source: "legacy",
    }, { claudeEntries: entries, pricingResolver: resolver });

    expect(report.rows.map((row) => [row.bucket, row.costUSD])).toEqual([
      ["2026-05-02", 4],
      ["2026-06-02", 9],
    ]);
  });

  it("does not resolve prices for provider costs and leaves display-only missing costs unallocated", async () => {
    let lookupCalls = 0;
    const historyPath = path.join(tmpRoot, "source-cost-prices.json");
    const resolver = new HistoricalPricingResolver({
      getModelPricing: async () => {
        lookupCalls++;
        return { output_cost_per_token: 4e-6 };
      },
    }, { historyPath });
    const source = { provider: "claude" as const, timestamp: "2026-06-02T12:00:00.000Z", model: "provider-priced", project: "project", session: "source", inputTokens: 0, outputTokens: 1_000_000, cacheCreationTokens: 0, cacheReadTokens: 0, costUSD: 7 };
    const missing = { provider: "claude" as const, timestamp: "2026-06-02T13:00:00.000Z", model: "display-only", project: "project", session: "missing", inputTokens: 0, outputTokens: 1_000_000, cacheCreationTokens: 0, cacheReadTokens: 0 };

    const auto = await generateUsageReport({ provider: "claude", type: "daily", timezone: "UTC", costMode: "auto", source: "legacy" }, {
      claudeEntries: [source], pricingResolver: resolver,
    });
    const display = await generateUsageReport({ provider: "claude", type: "daily", timezone: "UTC", costMode: "display", breakdown: true, source: "legacy" }, {
      claudeEntries: [source, missing], pricingResolver: resolver,
    });

    expect(auto.totals.costUSD).toBe(7);
    expect(lookupCalls).toBe(0);
    expect(await fs.stat(historyPath).then(() => true).catch(() => false)).toBe(false);
    const missingBreakdown = display.rows[0].modelBreakdowns!.find((item) => item.model === "display-only")!;
    expect(missingBreakdown).toMatchObject({ costUSD: 0, inputCostUSD: 0, outputCostUSD: 0, cacheCreationCostUSD: 0, cacheReadCostUSD: 0 });
  });

  it("aggregates Claude daily rows with project instances and costUSD in auto mode", async () => {
    const claudeRoot = path.join(tmpRoot, "claude", "projects");
    await writeJsonl(path.join(claudeRoot, "proj-a", "session-a.jsonl"), [
      {
        timestamp: "2026-05-18T23:30:00.000Z",
        costUSD: 1.25,
        sessionId: "s-a",
        message: { id: "m1", model: "claude-haiku-4-5", usage: { input_tokens: 100, output_tokens: 200 } },
      },
    ]);
    await writeJsonl(path.join(claudeRoot, "proj-b", "session-b.jsonl"), [
      {
        timestamp: "2026-05-19T00:30:00.000Z",
        costUSD: 2.5,
        sessionId: "s-b",
        message: { id: "m2", model: "claude-sonnet-4-5", usage: { input_tokens: 300, output_tokens: 400 } },
      },
    ]);

    const report = await generateUsageReport({
      provider: "claude",
      type: "daily",
      since: "2026-05-18",
      until: "2026-05-19",
      timezone: "UTC",
      instances: true,
      costMode: "auto",
      order: "asc",
      breakdown: true,
      source: "legacy",
    }, {
      settings: { ...defaultSettings, pricingOfflineMode: true },
      claudeProjectsDirs: [claudeRoot],
      codexSessionsDirs: [],
      codexConfigPaths: [],
    });

    expect(report.rows.map((row) => [row.bucket, row.provider, row.project, row.costUSD])).toEqual([
      ["2026-05-18", "claude", "proj-a", 1.25],
      ["2026-05-19", "claude", "proj-b", 2.5],
    ]);
    expect(report.totals.costUSD).toBeCloseTo(3.75, 6);
    expect(report.rows[0].modelBreakdowns).toHaveLength(1);
  });

  it("groups Claude weekly rows using Monday as the default week start", async () => {
    const claudeRoot = path.join(tmpRoot, "claude-weekly", "projects");
    await writeJsonl(path.join(claudeRoot, "proj", "session.jsonl"), [
      {
        timestamp: "2026-05-24T12:00:00.000Z",
        costUSD: 1,
        message: { id: "m1", model: "claude-haiku-4-5", usage: { output_tokens: 100 } },
      },
      {
        timestamp: "2026-05-25T12:00:00.000Z",
        costUSD: 2,
        message: { id: "m2", model: "claude-haiku-4-5", usage: { output_tokens: 100 } },
      },
    ]);

    const report = await generateUsageReport({
      provider: "claude",
      type: "weekly",
      timezone: "UTC",
      costMode: "auto",
      order: "asc",
      source: "legacy",
    }, {
      settings: { ...defaultSettings, pricingOfflineMode: true },
      claudeProjectsDirs: [claudeRoot],
      codexSessionsDirs: [],
      codexConfigPaths: [],
    });

    expect(report.rows.map((row) => [row.bucket, row.costUSD])).toEqual([
      ["2026-W21", 1],
      ["2026-W22", 2],
    ]);
  });

  it("aggregates Codex session rows and includes fallback flags", async () => {
    const sessions = path.join(tmpRoot, "codex", "sessions");
    await writeJsonl(path.join(sessions, "2026", "05", "18", "session-abc12345.jsonl"), [
      { timestamp: "2026-05-18T10:00:00.000Z", type: "turn_context", payload: { model: "gpt-4o" } },
      {
        timestamp: "2026-05-18T10:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: 1000, cached_input_tokens: 100, output_tokens: 50, reasoning_output_tokens: 10, total_tokens: 1050 },
          },
        },
      },
    ]);

    const report = await generateUsageReport({
      provider: "codex",
      type: "session",
      timezone: "UTC",
      codexSpeed: "standard",
      order: "asc",
      source: "legacy",
    }, {
      settings: { ...defaultSettings, pricingOfflineMode: true },
      claudeProjectsDirs: [],
      codexSessionsDirs: [sessions],
      codexConfigPaths: [],
    });

    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({
      provider: "codex",
      session: "session-abc12345",
      inputTokens: 900,
      cacheReadTokens: 100,
      outputTokens: 50,
      totalTokens: 1050,
      isFallback: false,
    });
    expect(report.totals.costUSD).toBeGreaterThan(0);
  });

  it("filters reports by project and date range", async () => {
    const claudeRoot = path.join(tmpRoot, "claude-filter", "projects");
    await writeJsonl(path.join(claudeRoot, "keep", "session.jsonl"), [
      { timestamp: "2026-05-02T10:00:00.000Z", costUSD: 99, message: { id: "old", model: "claude-haiku-4-5", usage: { output_tokens: 100 } } },
      { timestamp: "2026-05-18T10:00:00.000Z", costUSD: 4, message: { id: "m1", model: "claude-haiku-4-5", usage: { output_tokens: 100 } } },
    ]);
    await writeJsonl(path.join(claudeRoot, "drop", "session.jsonl"), [
      { timestamp: "2026-05-18T10:00:00.000Z", costUSD: 8, message: { id: "m2", model: "claude-haiku-4-5", usage: { output_tokens: 100 } } },
    ]);

    const report = await generateUsageReport({
      provider: "claude",
      type: "monthly",
      since: "2026-05-10",
      until: "2026-05-31",
      project: "keep",
      costMode: "auto",
      timezone: "UTC",
      source: "legacy",
    }, {
      settings: { ...defaultSettings, pricingOfflineMode: true },
      claudeProjectsDirs: [claudeRoot],
      codexSessionsDirs: [],
      codexConfigPaths: [],
    });

    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ bucket: "2026-05", project: "keep", costUSD: 4 });
    expect(report.totals.costUSD).toBe(4);
  });

  it("supports Claude auto, calculate, and display cost modes", async () => {
    const claudeRoot = path.join(tmpRoot, "claude-cost-modes", "projects");
    await writeJsonl(path.join(claudeRoot, "proj", "session.jsonl"), [
      { timestamp: "2026-05-18T10:00:00.000Z", costUSD: 7, message: { id: "official", model: "claude-haiku-4-5", usage: { output_tokens: 1000 } } },
      { timestamp: "2026-05-18T11:00:00.000Z", message: { id: "missing", model: "claude-haiku-4-5", usage: { output_tokens: 1000 } } },
    ]);
    const deps = {
      settings: { ...defaultSettings, pricingOfflineMode: true },
      claudeProjectsDirs: [claudeRoot],
      codexSessionsDirs: [],
      codexConfigPaths: [],
    };
    const base = { provider: "claude" as const, type: "daily" as const, timezone: "UTC", order: "asc" as const, source: "legacy" as const };

    const auto = await generateUsageReport({ ...base, costMode: "auto" }, deps);
    const calculate = await generateUsageReport({ ...base, costMode: "calculate" }, deps);
    const display = await generateUsageReport({ ...base, costMode: "display" }, deps);

    expect(auto.totals.costUSD).toBeCloseTo(7 + 1000 * 4e-6, 5);
    expect(calculate.totals.costUSD).toBeCloseTo(2000 * 4e-6, 5);
    expect(display.totals.costUSD).toBe(7);
  });
});

describe("legacy backfill", () => {
  async function writeBackfill(dir: string, events: unknown[]): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    const lines = events.map((e) => JSON.stringify({ ts: new Date().toISOString(), ...e as object }));
    // Dateiname aus dem date-Feld des ersten daySummary-Events bestimmen
    const date = (events.find((e) => (e as { kind?: string }).kind === "tokens.daySummary") as { date?: string } | undefined)?.date ?? "2026-01-01";
    await fs.writeFile(path.join(dir, `${date}.backfill.jsonl`), lines.join("\n") + "\n", "utf8");
  }

  it("gibt tägliche Claude-Zeilen mit vorberechneten Kosten zurück", async () => {
    const logDir = path.join(tmpRoot, "backfill-daily");
    await writeBackfill(logDir, [
      { kind: "tokens.daySummary", provider: "claude", date: "2026-05-18",
        input: 1000, output: 500, cacheCreation: 0, cacheRead: 2000,
        totalTokens: 3500, totalCostUSD: 0.05, sessionCount: 2,
        models: ["claude-sonnet-4-6"],
        perModel: { "claude-sonnet-4-6": { input: 1000, output: 500, cacheCreation: 0, cacheRead: 2000, costUSD: 0.05 } } },
    ]);
    await writeBackfill(logDir, [
      { kind: "tokens.daySummary", provider: "claude", date: "2026-05-19",
        input: 200, output: 100, cacheCreation: 0, cacheRead: 500,
        totalTokens: 800, totalCostUSD: 0.01, sessionCount: 1,
        models: ["claude-sonnet-4-6"],
        perModel: { "claude-sonnet-4-6": { input: 200, output: 100, cacheCreation: 0, cacheRead: 500, costUSD: 0.01 } } },
    ]);

    const report = await generateUsageReport({
      provider: "claude", type: "daily",
      since: "2026-05-18", until: "2026-05-19",
      timezone: "UTC", order: "asc", source: "legacy",
    }, { backfillLogDir: logDir });

    expect(report.rows).toHaveLength(2);
    expect(report.rows[0]).toMatchObject({ bucket: "2026-05-18", provider: "claude", costUSD: 0.05, inputTokens: 1000 });
    expect(report.rows[1]).toMatchObject({ bucket: "2026-05-19", provider: "claude", costUSD: 0.01 });
    expect(report.totals.costUSD).toBeCloseTo(0.06, 6);
  });

  it("keeps legacy stored backfill costs and bytes unchanged", async () => {
    const logDir = path.join(tmpRoot, "backfill-stable");
    await writeBackfill(logDir, [
      { kind: "tokens.daySummary", provider: "claude", date: "2026-05-18",
        input: 1000, output: 500, cacheCreation: 0, cacheRead: 0,
        totalTokens: 1500, totalCostUSD: 0.05, sessionCount: 1,
        models: ["claude-sonnet-4-6"],
        perModel: { "claude-sonnet-4-6": { input: 1000, output: 500, cacheCreation: 0, cacheRead: 0, costUSD: 0.05 } } },
    ]);
    const filePath = path.join(logDir, "2026-05-18.backfill.jsonl");
    const before = await fs.readFile(filePath, "utf8");

    const report = await generateUsageReport({
      provider: "claude", type: "daily", timezone: "UTC", source: "legacy",
    }, { backfillLogDir: logDir });

    expect(report.rows[0].costUSD).toBe(0.05);
    expect(await fs.readFile(filePath, "utf8")).toBe(before);
  });

  it("aggregiert mehrere Tage zu wöchentlichen Zeilen", async () => {
    const logDir = path.join(tmpRoot, "backfill-weekly");
    // 2026-05-18 = Montag (KW21), 2026-05-25 = Montag (KW22)
    for (const [date, cost] of [["2026-05-18", 1.0], ["2026-05-19", 2.0], ["2026-05-25", 3.0]] as [string, number][]) {
      await writeBackfill(logDir, [
        { kind: "tokens.daySummary", provider: "codex", date,
          input: 1000, output: 100, cachedInput: 900, reasoningOutput: 10,
          totalTokens: 1110, totalCostUSD: cost, sessionCount: 1,
          models: ["gpt-5.5"],
          perModel: { "gpt-5.5": { input: 1000, output: 100, cachedInput: 900, reasoningOutput: 10, costUSD: cost } } },
      ]);
    }

    const report = await generateUsageReport({
      provider: "codex", type: "weekly",
      timezone: "UTC", order: "asc", source: "legacy",
    }, { backfillLogDir: logDir });

    expect(report.rows).toHaveLength(2);
    expect(report.rows[0]).toMatchObject({ bucket: "2026-W21", costUSD: 3.0 }); // 1.0 + 2.0
    expect(report.rows[1]).toMatchObject({ bucket: "2026-W22", costUSD: 3.0 });
  });

  it("uses legacy provider entries when backfill cannot represent sessions", async () => {
    const logDir = path.join(tmpRoot, "backfill-session-fallback");
    const claudeRoot = path.join(tmpRoot, "claude-fallback", "projects");
    await writeJsonl(path.join(claudeRoot, "proj", "session.jsonl"), [
      { timestamp: "2026-05-18T10:00:00.000Z", costUSD: 5,
        message: { id: "m1", model: "claude-haiku-4-5", usage: { output_tokens: 100 } } },
    ]);

    const report = await generateUsageReport({
      provider: "claude", type: "session",
      timezone: "UTC", source: "legacy",
    }, {
      settings: { ...defaultSettings, pricingOfflineMode: true },
      claudeProjectsDirs: [claudeRoot],
      codexSessionsDirs: [],
      codexConfigPaths: [],
      backfillLogDir: logDir,
    });

    expect(report.rows.length).toBeGreaterThan(0);
    expect(report.rows[0].session).toBeDefined();
  });

  it("gibt model-Breakdowns zurück wenn breakdown=true", async () => {
    const logDir = path.join(tmpRoot, "backfill-breakdown");
    await writeBackfill(logDir, [
      { kind: "tokens.daySummary", provider: "claude", date: "2026-05-18",
        input: 1000, output: 500, cacheCreation: 0, cacheRead: 0,
        totalTokens: 1500, totalCostUSD: 0.02, sessionCount: 1,
        models: ["claude-sonnet-4-6", "claude-haiku-4-5"],
        perModel: {
          "claude-sonnet-4-6": { input: 800, output: 400, cacheCreation: 0, cacheRead: 0, costUSD: 0.015 },
          "claude-haiku-4-5":  { input: 200, output: 100, cacheCreation: 0, cacheRead: 0, costUSD: 0.005 },
        } },
    ]);

    const report = await generateUsageReport({
      provider: "claude", type: "daily", timezone: "UTC",
      source: "legacy", breakdown: true,
    }, { backfillLogDir: logDir });

    expect(report.rows[0].modelBreakdowns).toHaveLength(2);
    const sonnet = report.rows[0].modelBreakdowns!.find((b) => b.model === "claude-sonnet-4-6");
    expect(sonnet).toMatchObject({ inputTokens: 800, costUSD: 0.015 });
  });
});
