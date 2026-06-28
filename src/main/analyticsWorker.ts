import { parentPort } from "node:worker_threads";
import type { Settings } from "../config/settings";
import { generateUsageReport } from "../reports/reportService";
import { readClaudeUsageEntriesForPeriod } from "../pricing/jsonl-reader";
import { readCodexTokensForPeriod } from "../pricing/codex-log-reader";
import {
  computeActiveDays, buildSparkline7d, buildTopModels,
  computeAvgSessionMinutes,
  buildDailyBuckets, buildSessionStats, buildTotalTokens,
  buildHourHeatmap, buildWeekdayDistribution, buildTopActiveDays,
  buildWeeklySummary, buildCostEfficiency, computeActiveHours,
  localDayKey,
  type AnalyticsSummary, type AnalyticsData,
} from "./analyticsSummary";
import { buildModelsData, type ModelsData } from "./modelsData";
import { dailySubCostUSD, periodSubCostUSD, planChangePoints, type PlanChangePoint } from "../pricing/plan-cost";
import { makeFxLookup } from "../pricing/fx-fetcher";
import { readBackfillDayRecords } from "../reports/backfill-reader";
import { buildWeeklyProfile, computeWeeklyForecast, type WeeklyForecastResult } from "./weeklyForecast";
import { readWeeklySeriesForProviders, type WindowBudgetSeries } from "./windowBudgetSeries";
import { readWindowHistoryObservations } from "./windowHistoryReader";
import { buildWindowHistory, buildFiveHourPressure, type WindowHistoryEntry } from "../usage/windowHistory";
import type { UsagePace } from "../usage/usagePace";
import type { CurrentWindowUsage } from "../usage/windowBudgetRollup";

interface AnalyticsTaskInput {
  task: "get" | "summary";
  claudeProjectsDirs: string[];
  codexSessionsDirs: string[];
  periodStartMs: number;
  windowDays: number;
  since: string;
  until?: string;
  settings: Settings;
  cacheHitRate: { claude: number; codex: number };
  eurUsdRates?: Record<string, number>;
  fxEstimated?: boolean;
  logDir: string;   // NEW: snapshot debug logs for fivePct
  nowMs: number;    // NEW: upper bound when `until` is absent
}

interface ModelsTaskInput {
  task: "models";
  settings: Settings;
}

interface WindowBudgetTaskInput {
  task: "windowBudget";
  logDir: string;
  nowMs: number;
  providers: Array<{
    provider: "claude" | "codex";
    weeklyUsedPercent: number;
    weeklyResetsAt: string | null;
    windowsPerWeek: number;
    burnRatePctPerHour: number | null;
    pace: UsagePace | null;
    planType: string | null;
  }>;
}

export interface WindowBudgetProviderData {
  series: WindowBudgetSeries;
  forecast: WeeklyForecastResult;
  hasSeriesData: boolean;
  currentUsage: CurrentWindowUsage | null;
}

export interface WindowBudgetData {
  perProvider: Record<string, WindowBudgetProviderData>;
}

interface WindowHistoryTaskInput {
  task: "windowHistory";
  logDir: string;
  nowMs: number;
}

export interface WindowHistoryData {
  entries: WindowHistoryEntry[];
}

type WorkerInput = AnalyticsTaskInput | ModelsTaskInput | WindowBudgetTaskInput | WindowHistoryTaskInput;

async function run(input: WorkerInput): Promise<AnalyticsSummary | AnalyticsData | ModelsData | WindowBudgetData | WindowHistoryData> {
  if (input.task === "models") {
    return buildModelsData({ settings: input.settings });
  }
  if (input.task === "windowBudget") {
    return buildWindowBudgetData(input);
  }
  if (input.task === "windowHistory") {
    const observations = await readWindowHistoryObservations(input.logDir);
    return { entries: buildWindowHistory(observations, input.nowMs) };
  }

  const periodStart = new Date(input.periodStartMs);

  const [claudeEntriesAll, codexEventsAll] = await Promise.all([
    readClaudeUsageEntriesForPeriod(input.claudeProjectsDirs, periodStart),
    readCodexTokensForPeriod(input.codexSessionsDirs, periodStart),
  ]);

  // Die Reader begrenzen nur nach unten (periodStart). Bei einem Enddatum in der
  // Vergangenheit (eigene Auswahl) müssen die entry-basierten Statistiken
  // (Sessions, Heatmap, 5h-Peak, …) zusätzlich nach oben auf `until` begrenzt
  // werden — sonst zählen sie Aktivität nach dem gewählten Zeitraum mit.
  const untilKey = input.until;
  const claudeEntries = untilKey
    ? claudeEntriesAll.filter(e => localDayKey(e.timestamp) <= untilKey)
    : claudeEntriesAll;
  const codexEvents = untilKey
    ? codexEventsAll.filter(e => localDayKey(e.timestamp) <= untilKey)
    : codexEventsAll;

  const [claudeReport, codexReport] = await Promise.all([
    generateUsageReport(
      { type: "daily", provider: "claude", since: input.since, until: input.until, order: "asc", breakdown: true },
      { settings: input.settings, claudeEntries },
    ),
    generateUsageReport(
      { type: "daily", provider: "codex", since: input.since, until: input.until, order: "asc", breakdown: true },
      { settings: input.settings, codexEvents },
    ),
  ]);

  const activeDays        = computeActiveDays(claudeReport.rows, codexReport.rows);
  const sparkline7d       = buildSparkline7d(claudeReport.rows, codexReport.rows);
  const topModels         = buildTopModels(claudeReport.rows, codexReport.rows, 5);
  const avgSessionMinutes = computeAvgSessionMinutes(claudeEntries);
  const { cacheHitRate }  = input;

  // When windowDays === 0 (sentinel for "all time"), derive span from actual data
  let windowDays = input.windowDays;
  if (windowDays === 0) {
    const buckets = [...claudeReport.rows, ...codexReport.rows].map(r => r.bucket).sort();
    windowDays = buckets.length > 0
      ? Math.ceil((Date.now() - new Date(buckets[0]).getTime()) / (24 * 3600 * 1000)) + 1
      : 30;
  }

  const claudeCost = claudeReport.totals.costUSD;
  const codexCost  = codexReport.totals.costUSD;

  // Real plan-based subscription costs (time-varying), summed over the period.
  const fx = makeFxLookup(input.eurUsdRates ?? {}, input.fxEstimated ?? false);
  const untilDay = input.until ?? localDayKey(new Date(Date.now()).toISOString());
  const claudePeriodSub  = periodSubCostUSD(input.settings.plans, "claude", input.since, untilDay, fx);
  const codexPeriodSub   = periodSubCostUSD(input.settings.plans, "codex",  input.since, untilDay, fx);
  const combinedPeriodSub = claudePeriodSub + codexPeriodSub;

  const roiFactor = {
    claude:   claudePeriodSub  > 0 ? claudeCost  / claudePeriodSub  : 0,
    codex:    codexPeriodSub   > 0 ? codexCost   / codexPeriodSub   : 0,
    combined: combinedPeriodSub > 0 ? (claudeCost + codexCost) / combinedPeriodSub : 0,
  };

  if (input.task === "summary") {
    const result: AnalyticsSummary = {
      apiCostUSD:          { claude: claudeCost, codex: codexCost, total: claudeCost + codexCost },
      subscriptionCostUSD: { claude: claudePeriodSub, codex: codexPeriodSub, total: combinedPeriodSub },
      roiFactor,
      activeDays, avgSessionMinutes, cacheHitRate, sparkline7d, topModels,
      windowDays,
    };
    return result;
  }

  const dailyBuckets      = buildDailyBuckets(claudeReport.rows, codexReport.rows, input.since, input.until ?? input.since);
  for (const b of dailyBuckets) {
    b.claudeSubUSD = dailySubCostUSD(input.settings.plans, "claude", b.date, fx);
    b.codexSubUSD  = dailySubCostUSD(input.settings.plans, "codex",  b.date, fx);
  }
  const planChanges: PlanChangePoint[] = [
    ...planChangePoints(input.settings.plans, "claude", input.since, untilDay),
    ...planChangePoints(input.settings.plans, "codex",  input.since, untilDay),
  ];
  const sessionStats      = buildSessionStats(claudeEntries, activeDays);
  const totalTokens       = buildTotalTokens(claudeReport.rows, codexReport.rows);
  const hourHeatmap       = buildHourHeatmap(claudeEntries);
  const weekdayDistribution = buildWeekdayDistribution(claudeEntries);
  const topActiveDays     = buildTopActiveDays(claudeEntries, claudeReport.rows, 5);
  const pressureObs = await readWindowHistoryObservations(input.logDir);
  const sinceMs = input.periodStartMs;
  const untilMs = input.until
    ? new Date(`${input.until}T00:00:00`).getTime() + 24 * 3600 * 1000
    : input.nowMs;
  const fiveHourPressure = {
    claude: buildFiveHourPressure(pressureObs, sinceMs, untilMs, "claude"),
    codex:  buildFiveHourPressure(pressureObs, sinceMs, untilMs, "codex"),
  };
  const weeklySummary     = buildWeeklySummary(claudeReport.rows, codexReport.rows, claudeEntries, codexEvents);
  const costEfficiency    = buildCostEfficiency(claudeCost, totalTokens.claude.output, computeActiveHours(claudeEntries), claudePeriodSub);

  const result: AnalyticsData = {
    apiCostUSD:          { claude: claudeCost, codex: codexCost, total: claudeCost + codexCost },
    subscriptionCostUSD: { claude: claudePeriodSub, codex: codexPeriodSub, total: combinedPeriodSub },
    roiFactor,
    activeDays, avgSessionMinutes, cacheHitRate, sparkline7d, topModels,
    windowDays,
    dailyBuckets, sessionStats, totalTokens,
    hourHeatmap, weekdayDistribution, topActiveDays, fiveHourPressure, weeklySummary, costEfficiency,
    planChanges,
  };
  return result;
}

const DAY_MS = 24 * 3600 * 1000;
const WEEK_MS = 7 * DAY_MS;

async function buildWindowBudgetData(input: WindowBudgetTaskInput): Promise<WindowBudgetData> {
  const now = new Date(input.nowMs);
  const records = await readBackfillDayRecords(input.logDir, new Date(input.nowMs - 28 * DAY_MS));
  const perProvider: Record<string, WindowBudgetProviderData> = {};
  const windowStarts = input.providers.map((p) => {
    const resetMs = p.weeklyResetsAt ? new Date(p.weeklyResetsAt).getTime() : null;
    return resetMs !== null && !Number.isNaN(resetMs) ? resetMs - WEEK_MS : input.nowMs - WEEK_MS;
  });
  // Alle Provider-Serien in einem einzigen Log-Durchlauf lesen, statt die
  // Dateien pro Provider erneut zu parsen.
  const seriesList = await readWeeklySeriesForProviders(
    input.logDir,
    input.providers.map((p, i) => ({
      provider: p.provider,
      windowStartMs: windowStarts[i],
      planType: p.planType,
      windowsPerWeek: p.windowsPerWeek,
      currentWeeklyPct: p.weeklyUsedPercent,
    })),
    input.nowMs,
    30,
  );
  for (let i = 0; i < input.providers.length; i++) {
    const p = input.providers[i];
    const windowStartMs = windowStarts[i];
    const series = seriesList[i];
    const profile = buildWeeklyProfile(records, p.provider, now);
    const windowStartKey = new Date(windowStartMs).toISOString().slice(0, 10);
    const tokensInCurrentWindow = records
      .filter((r) => r.provider === p.provider && r.date >= windowStartKey)
      .reduce((sum, r) => sum + r.totalTokens, 0);
    const forecast = computeWeeklyForecast({
      weeklyUsedPercent: p.weeklyUsedPercent,
      weeklyResetsAt: p.weeklyResetsAt,
      tokensInCurrentWindow,
      burnRatePctPerHour: p.burnRatePctPerHour,
      pace: p.pace,
      profile,
      now,
    });
    perProvider[p.provider] = {
      series,
      forecast,
      hasSeriesData: series.points.length > 0,
      currentUsage: series.currentUsage ?? null,
    };
  }
  return { perProvider };
}

// Long-lived worker: requests arrive as messages and are answered by id, so
// the module-level FileParseCaches in the JSONL readers stay warm between
// requests (unchanged files are re-stat'ed, not re-parsed).
async function handleRequest(request: WorkerInput & { id: number }): Promise<void> {
  try {
    const result = await run(request);
    parentPort!.postMessage({ id: request.id, ok: true, result });
  } catch (err) {
    parentPort!.postMessage({ id: request.id, ok: false, error: String(err) });
  }
}

parentPort!.on("message", (request: WorkerInput & { id: number }) => {
  void handleRequest(request);
});
