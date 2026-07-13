import path from "node:path";
import { describe, expect, it } from "vitest";
import { flush, rendererHarness } from "./helpers/rendererHarness";

const renderer = path.join(__dirname, "..", "src", "renderer");
const preparing = { portableDataPreparing: true };
const summary = { apiCostUSD: { total: 5 }, subscriptionCostUSD: { total: 2 }, roiFactor: { combined: 2.5 }, activeDays: 1, windowDays: 30, avgSessionMinutes: 10, topModels: [], sparkline7d: [] };
const analytics = {
  ...summary, cacheHitRate: { claude: 0, codex: 0 }, dailyBuckets: [], planChanges: [], topModels: [],
  sessionDurationBuckets: { daily: [], weekly: [], monthly: [] },
  sessionStats: { claude: {}, codex: {}, all: {} }, totalTokens: { claude: { input: 0, output: 0 }, codex: { input: 0, output: 0 } },
  hourHeatmap: { claude: [], codex: [], all: [] }, weekdayDistribution: { claude: [], codex: [], all: [] },
  topActiveDays: { claude: [], codex: [], all: [] }, fiveHourPressure: { claude: { buckets: { crit: 0, high: 0, mid: 0, low: 0, min: 0 }, total: 0, hotCount: 0, worst: null }, codex: { buckets: { crit: 0, high: 0, mid: 0, low: 0, min: 0 }, total: 0, hotCount: 0, worst: null }, all: { buckets: { crit: 0, high: 0, mid: 0, low: 0, min: 0 }, total: 0, hotCount: 0, worst: null } },
  costEfficiency: { claude: {}, codex: {}, all: {} }, weeklySummary: [],
};

describe("portable renderer preparing behavior", () => {
  it("retries dashboard summary after preparing and renders valid data", async () => {
    const h = rendererHarness({
      "app:meta": [{ version: "1" }], "settings:get": [{ costWindow: "30d" }, { costWindow: "30d" }],
      "analytics:summary": [preparing, summary, summary, summary],
    });
    h.run(path.join(renderer, "shared", "ipc.js")); h.run(path.join(renderer, "app-shell.js"));
    await h.handlers.get("quota:ready-ack")?.({ viewMode: "dashboard" }); await flush();
    expect(h.document.getElementById("qs-api-cost").textContent).toContain("Preparing data");
    await h.handlers.get("quota:ready-ack")?.({ viewMode: "dashboard" }); await flush();
    expect(h.calls.filter((call) => call === "analytics:summary").length).toBeGreaterThan(1);
    expect(h.document.getElementById("qs-api-cost").textContent).toBe("$5");
  });

  it("retries models after preparing and renders valid days", async () => {
    const h = rendererHarness({ "models:get": [preparing, { days: [], benchmarks: {}, benchmarksAsOf: "", benchmarkIndexes: {}, pricing: {}, minModelTokenSharePct: 0 }] });
    h.run(path.join(renderer, "shared", "ipc.js")); h.run(path.join(renderer, "tabs", "models-calc.js")); h.run(path.join(renderer, "tabs", "models.js"));
    await h.QB.renderModels();
    expect(h.document.getElementById("models-content").innerHTML).toContain("Preparing data");
    await h.QB.renderModels();
    expect(h.calls.filter((call) => call === "models:get")).toHaveLength(2);
    expect(h.document.getElementById("models-content").innerHTML).toContain("MODEL DETAILS");
    await h.QB.renderModels();
    expect(h.calls.filter((call) => call === "models:get")).toHaveLength(2);
  });

  it("retries analytics and window history after preparing", async () => {
    const h = rendererHarness({ "reports:get": [{ rows: [] }], "analytics:get": [preparing, analytics, analytics], "windowHistory:get": [preparing, { entries: [], planChanges: [] }] });
    h.run(path.join(renderer, "shared", "ipc.js")); h.run(path.join(renderer, "tabs", "analytics.js"));
    await h.QB.renderAnalytics();
    expect(h.document.getElementById("an-results").innerHTML).toContain("Preparing data");
    await h.QB.renderAnalytics(); await flush();
    expect(h.calls.filter((call) => call === "analytics:get")).toHaveLength(2);
    expect(h.document.getElementById("an-results").innerHTML).toContain("USAGE BREAKDOWN");
    expect(h.document.getElementById("an-wh-note").textContent).toContain("Preparing data");
    await h.QB.renderAnalytics();
    expect(h.calls.filter((call) => call === "analytics:get")).toHaveLength(2);
    h.QB.clearAnalyticsCache(); await h.QB.renderAnalytics(); await flush();
    expect(h.calls.filter((call) => call === "windowHistory:get")).toHaveLength(2);
  });

  it("retries window budget hydration after preparing", async () => {
    const valid = { perProvider: { claude: { forecast: { reason: "insufficient-data", primaryKind: "linear", confidence: "none", primaryLastsUntilReset: false, burnRateLastsUntilReset: null }, series: { points: [] }, hasSeriesData: false, currentUsage: null } } };
    const h = rendererHarness({ "windowBudget:get": [preparing, valid] });
    h.run(path.join(renderer, "shared", "ipc.js")); h.run(path.join(renderer, "tabs", "live.js"));
    const snapshots = [{ provider: "claude", status: "ok", windows: [{ name: "weekly", usedPercent: 10 }], windowBudget: { learning: false, windowsPerWeek: 2, usedWindows: .2, remainingWindows: 1.8 } }];
    h.QB.renderLive(snapshots); await flush();
    expect(h.document.getElementById("wb-forecast-claude").textContent).toContain("Preparing data");
    h.QB.renderLive(snapshots); await flush();
    expect(h.calls.filter((call) => call === "windowBudget:get")).toHaveLength(2);
    expect(h.document.getElementById("wb-forecast-claude").innerHTML).toContain("No reliable forecast");
  });
});
