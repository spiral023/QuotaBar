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
    expect(h.timers.pendingCount()).toBe(1);
    h.timers.advanceBy(1_000); await flush();
    expect(h.invocations.filter(({ channel, args }) => channel === "analytics:summary" && (args[0] as any)?.costWindow === "30d")).toHaveLength(2);
    expect(h.document.getElementById("qs-api-cost").textContent).toBe("$5");
    expect(h.timers.pendingCount()).toBe(0);
  });

  it("cancels a pending summary retry when another window becomes active", async () => {
    const sevenDay = { ...summary, apiCostUSD: { total: 7 } };
    const thirtyDay = { ...summary, apiCostUSD: { total: 30 } };
    const h = rendererHarness({
      "app:meta": [{ version: "1" }], "settings:get": [{ costWindow: "7d" }],
      "analytics:summary": [preparing, thirtyDay, summary, sevenDay],
    });
    h.run(path.join(renderer, "shared", "ipc.js")); h.run(path.join(renderer, "app-shell.js"));
    await h.handlers.get("quota:ready-ack")?.({ viewMode: "dashboard" }); await flush();
    expect(h.timers.pendingCount()).toBe(1);
    const thirtyDayPill = h.document.windowPills.find((pill) => pill.dataset.win === "30d")!;
    await thirtyDayPill.emit("click"); await flush();
    expect(h.document.getElementById("qs-api-cost").textContent).toBe("$30");
    const sevenDayCalls = () => h.invocations.filter(({ channel, args }) => channel === "analytics:summary" && (args[0] as any)?.costWindow === "7d").length;
    expect(sevenDayCalls()).toBe(1);
    h.timers.advanceBy(1_000); await flush();
    expect(sevenDayCalls()).toBe(1);
    expect(h.document.getElementById("qs-api-cost").textContent).toBe("$30");
  });

  it("retries models after preparing and renders valid days", async () => {
    const h = rendererHarness({ "models:get": [preparing, preparing, { days: [], benchmarks: {}, benchmarksAsOf: "", benchmarkIndexes: {}, pricing: {}, minModelTokenSharePct: 0 }] });
    h.run(path.join(renderer, "shared", "ipc.js")); h.run(path.join(renderer, "tabs", "models-calc.js")); h.run(path.join(renderer, "tabs", "models.js"));
    await h.QB.renderModels();
    expect(h.document.getElementById("models-content").innerHTML).toContain("Preparing data");
    expect(h.timers.pendingCount()).toBe(1);
    await h.QB.renderModels();
    expect(h.calls.filter((call) => call === "models:get")).toHaveLength(2);
    expect(h.timers.pendingCount()).toBe(1);
    h.timers.advanceBy(1_000); await flush();
    expect(h.calls.filter((call) => call === "models:get")).toHaveLength(3);
    expect(h.document.getElementById("models-content").innerHTML).toContain("MODEL DETAILS");
    await h.QB.renderModels();
    expect(h.calls.filter((call) => call === "models:get")).toHaveLength(3);
    expect(h.timers.pendingCount()).toBe(0);
  });

  it("retries analytics and window history after preparing", async () => {
    const h = rendererHarness({ "reports:get": [{ rows: [] }], "analytics:get": [preparing, analytics, analytics], "windowHistory:get": [preparing, { entries: [], planChanges: [] }] });
    h.run(path.join(renderer, "shared", "ipc.js")); h.run(path.join(renderer, "tabs", "analytics.js"));
    await h.QB.renderAnalytics();
    expect(h.document.getElementById("an-results").innerHTML).toContain("Preparing data");
    expect(h.timers.pendingCount()).toBe(1);
    h.timers.advanceBy(1_000); await flush();
    expect(h.calls.filter((call) => call === "analytics:get")).toHaveLength(2);
    expect(h.document.getElementById("an-results").innerHTML).toContain("USAGE BREAKDOWN");
    expect(h.document.getElementById("an-wh-note").textContent).toContain("Preparing data");
    expect(h.timers.pendingCount()).toBe(1);
    h.timers.advanceBy(2_000); await flush();
    expect(h.calls.filter((call) => call === "windowHistory:get")).toHaveLength(2);
    expect(h.timers.pendingCount()).toBe(0);
  });

  it("retries window budget hydration after preparing", async () => {
    const valid = { perProvider: { claude: { forecast: { reason: "insufficient-data", primaryKind: "linear", confidence: "none", primaryLastsUntilReset: false, burnRateLastsUntilReset: null }, series: { points: [] }, hasSeriesData: false, currentUsage: null } } };
    const h = rendererHarness({ "windowBudget:get": [preparing, valid] });
    h.run(path.join(renderer, "shared", "ipc.js")); h.run(path.join(renderer, "tabs", "live.js"));
    const snapshots = [{ provider: "claude", status: "ok", windows: [{ name: "weekly", usedPercent: 10 }], windowBudget: { learning: false, windowsPerWeek: 2, usedWindows: .2, remainingWindows: 1.8 } }];
    h.QB.renderLive(snapshots); await flush();
    expect(h.document.getElementById("wb-forecast-claude").textContent).toContain("Preparing data");
    expect(h.timers.pendingCount()).toBe(1);
    h.timers.advanceBy(1_000); await flush();
    expect(h.calls.filter((call) => call === "windowBudget:get")).toHaveLength(2);
    expect(h.document.getElementById("wb-forecast-claude").innerHTML).toContain("No reliable forecast");
    expect(h.timers.pendingCount()).toBe(0);
  });

  it("cancels an old window-budget retry when newer snapshots start loading", async () => {
    let resolveCurrent!: (value: unknown) => void;
    const current = new Promise((resolve) => { resolveCurrent = resolve; });
    const valid = { perProvider: { claude: { forecast: { reason: "insufficient-data", primaryKind: "linear", confidence: "none", primaryLastsUntilReset: false, burnRateLastsUntilReset: null }, series: { points: [{}] }, hasSeriesData: true, currentUsage: null } } };
    const h = rendererHarness({ "windowBudget:get": [preparing, current] });
    const chartResets: string[] = [];
    h.QB.weeklyBudgetChart = (_context: unknown, _series: unknown, _forecast: unknown, resetsAt: string) => { chartResets.push(resetsAt); return { destroy() {} }; };
    h.run(path.join(renderer, "shared", "ipc.js")); h.run(path.join(renderer, "tabs", "live.js"));
    const snapshot = (email: string, resetsAt: string) => [{ provider: "claude", status: "ok", identity: { email }, windows: [{ name: "weekly", usedPercent: 10, resetsAt }], windowBudget: { learning: false, windowsPerWeek: 2, usedWindows: .2, remainingWindows: 1.8 } }];
    h.QB.renderLive(snapshot("old@example.com", "2026-07-20T00:00:00.000Z")); await flush();
    expect(h.timers.pendingCount()).toBe(1);
    h.QB.renderLive(snapshot("new@example.com", "2026-07-21T00:00:00.000Z")); await flush();
    const currentMarkup = h.document.getElementById("content").innerHTML;
    h.timers.advanceBy(1_000); await flush();
    resolveCurrent(valid); await flush();
    expect(h.document.getElementById("content").innerHTML).toBe(currentMarkup);
    expect(currentMarkup).toContain("new@example.com");
    expect(chartResets).toEqual(["2026-07-21T00:00:00.000Z"]);
    expect(h.timers.pendingCount()).toBe(0);
  });
});
