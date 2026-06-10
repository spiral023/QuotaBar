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
  buildFiveHourPeak, buildWeeklySummary, buildCostEfficiency, computeActiveHours,
  type AnalyticsSummary, type AnalyticsData,
} from "./analyticsSummary";

interface WorkerInput {
  task: "get" | "summary";
  claudeProjectsDirs: string[];
  codexSessionsDirs: string[];
  periodStartMs: number;
  windowDays: number;
  since: string;
  settings: Settings;
  cacheHitRate: { claude: number; codex: number };
}

async function run(input: WorkerInput): Promise<AnalyticsSummary | AnalyticsData> {
  const periodStart = new Date(input.periodStartMs);

  const [claudeEntries, codexEvents] = await Promise.all([
    readClaudeUsageEntriesForPeriod(input.claudeProjectsDirs, periodStart),
    readCodexTokensForPeriod(input.codexSessionsDirs, periodStart),
  ]);

  const [claudeReport, codexReport] = await Promise.all([
    generateUsageReport(
      { type: "daily", provider: "claude", since: input.since, order: "asc", breakdown: true },
      { settings: input.settings, claudeEntries },
    ),
    generateUsageReport(
      { type: "daily", provider: "codex", since: input.since, order: "asc", breakdown: true },
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
  const claudeSub  = input.settings.subscriptionCosts.claude;
  const codexSub   = input.settings.subscriptionCosts.codex;

  // Normalize ROI to the actual window duration so all windows are comparable.
  // periodSubCost = monthlySubCost × windowDays/30
  const claudePeriodSub  = claudeSub  * windowDays / 30;
  const codexPeriodSub   = codexSub   * windowDays / 30;
  const combinedPeriodSub = claudePeriodSub + codexPeriodSub;

  const roiFactor = {
    claude:   claudePeriodSub  > 0 ? claudeCost  / claudePeriodSub  : 0,
    codex:    codexPeriodSub   > 0 ? codexCost   / codexPeriodSub   : 0,
    combined: combinedPeriodSub > 0 ? (claudeCost + codexCost) / combinedPeriodSub : 0,
  };

  if (input.task === "summary") {
    const result: AnalyticsSummary = {
      apiCostUSD:          { claude: claudeCost, codex: codexCost, total: claudeCost + codexCost },
      subscriptionCostUSD: { claude: claudeSub,  codex: codexSub,  total: claudeSub  + codexSub  },
      roiFactor,
      activeDays, avgSessionMinutes, cacheHitRate, sparkline7d, topModels,
      windowDays,
    };
    return result;
  }

  const dailyBuckets      = buildDailyBuckets(claudeReport.rows, codexReport.rows, input.windowDays);
  const sessionStats      = buildSessionStats(claudeEntries, activeDays);
  const totalTokens       = buildTotalTokens(claudeReport.rows, codexReport.rows);
  const hourHeatmap       = buildHourHeatmap(claudeEntries);
  const weekdayDistribution = buildWeekdayDistribution(claudeEntries);
  const topActiveDays     = buildTopActiveDays(claudeEntries, claudeReport.rows, 5);
  const fiveHourPeak      = buildFiveHourPeak(claudeEntries);
  const weeklySummary     = buildWeeklySummary(claudeReport.rows, codexReport.rows, claudeEntries, codexEvents);
  const costEfficiency    = buildCostEfficiency(claudeCost, totalTokens.claude.output, computeActiveHours(claudeEntries), claudePeriodSub);

  const result: AnalyticsData = {
    apiCostUSD:          { claude: claudeCost, codex: codexCost, total: claudeCost + codexCost },
    subscriptionCostUSD: { claude: claudeSub,  codex: codexSub,  total: claudeSub  + codexSub  },
    roiFactor,
    activeDays, avgSessionMinutes, cacheHitRate, sparkline7d, topModels,
    windowDays,
    dailyBuckets, sessionStats, totalTokens,
    hourHeatmap, weekdayDistribution, topActiveDays, fiveHourPeak, weeklySummary, costEfficiency,
  };
  return result;
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
