export const summary = { apiCostUSD: { total: 5 }, subscriptionCostUSD: { total: 2 }, roiFactor: { combined: 2.5 }, activeDays: 1, windowDays: 30, avgSessionMinutes: 10, topModels: [], sparkline7d: [] };
export const analytics = {
  ...summary, cacheHitRate: { claude: 0, codex: 0 }, dailyBuckets: [], planChanges: [], topModels: [],
  sessionDurationBuckets: { daily: [], weekly: [], monthly: [] },
  sessionStats: { claude: {}, codex: {}, all: {} }, totalTokens: { claude: { input: 0, output: 0 }, codex: { input: 0, output: 0 } },
  hourHeatmap: { claude: [], codex: [], all: [] }, weekdayDistribution: { claude: [], codex: [], all: [] },
  topActiveDays: { claude: [], codex: [], all: [] }, fiveHourPressure: { claude: { buckets: { crit: 0, high: 0, mid: 0, low: 0, min: 0 }, total: 0, hotCount: 0, worst: null }, codex: { buckets: { crit: 0, high: 0, mid: 0, low: 0, min: 0 }, total: 0, hotCount: 0, worst: null }, all: { buckets: { crit: 0, high: 0, mid: 0, low: 0, min: 0 }, total: 0, hotCount: 0, worst: null } },
  costEfficiency: { claude: {}, codex: {}, all: {} }, weeklySummary: [],
};
