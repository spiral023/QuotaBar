import { describe, expect, it } from "vitest";
import { buildActivityMetrics } from "../src/main/analyticsActivity";
import { buildHourHeatmap, buildSessionStats, buildTopActiveDays, buildWeekdayDistribution, type ActivityEntry } from "../src/main/analyticsSummary";
import type { ReportRow } from "../src/reports/types";

describe("shared activity aggregation", () => {
  it.each([0, 1, 250])("preserves independent provider and combined metrics for %i events", (count) => {
    const entries: ActivityEntry[] = Array.from({ length: count }, (_, i) => ({
      timestamp: new Date(Date.parse("2026-10-24T23:00:00Z") + ((i * 1777) % 60000) * 1000).toISOString(),
      project: `provider-${i % 2}`, session: `session-${i % 17}`, outputTokens: i,
    }));
    const claude = entries.filter((_, i) => i % 2 === 0), codex = entries.filter((_, i) => i % 2 !== 0);
    const all = [...claude, ...codex];
    const rows = [{ bucket: "2026-10-25", outputTokens: 123 } as ReportRow];
    const metrics = buildActivityMetrics(claude, codex, 3, rows, rows);
    for (const [key, group] of [["claude", claude], ["codex", codex], ["all", all]] as const) {
      expect(metrics.sessionStats[key]).toEqual(buildSessionStats(group, 3));
      expect(metrics.hourHeatmap[key]).toEqual(buildHourHeatmap(group));
      expect(metrics.weekdayDistribution[key]).toEqual(buildWeekdayDistribution(group));
      expect(metrics.topActiveDays[key]).toEqual(buildTopActiveDays(group, key === "all" ? [...rows, ...rows] : rows, 5));
    }
  });
});
