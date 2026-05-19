import { describe, it, expect } from "vitest";
import type { ReportRow } from "../src/reports/types";
import type { ClaudeUsageEntry } from "../src/pricing/jsonl-reader";
import {
  buildHourHeatmap,
  buildWeekdayDistribution,
  buildTopActiveDays,
} from "../src/main/analyticsSummary";

function makeEntry(isoTimestamp: string, out = 0): ClaudeUsageEntry {
  return {
    provider: "claude", timestamp: isoTimestamp, model: "claude-sonnet-4-6",
    project: "p1", session: "s1",
    inputTokens: 0, outputTokens: out, cacheCreationTokens: 0, cacheReadTokens: 0,
  };
}

function makeRow(bucket: string, outputTokens: number): ReportRow {
  return {
    bucket, provider: "claude", costUSD: 0,
    inputTokens: 0, outputTokens, cacheCreationTokens: 0, cacheReadTokens: 0,
    totalTokens: outputTokens, models: [], modelBreakdowns: [],
  };
}

describe("buildHourHeatmap", () => {
  it("returns exactly 24 entries for hours 0–23", () => {
    const result = buildHourHeatmap([]);
    expect(result).toHaveLength(24);
    expect(result.map(b => b.hour)).toEqual(Array.from({ length: 24 }, (_, i) => i));
  });

  it("counts entries by UTC hour", () => {
    const entries = [
      makeEntry("2026-05-01T14:30:00.000Z"),
      makeEntry("2026-05-01T14:59:00.000Z"),
      makeEntry("2026-05-01T16:00:00.000Z"),
    ];
    const result = buildHourHeatmap(entries);
    expect(result[14].count).toBe(2);
    expect(result[16].count).toBe(1);
    expect(result[0].count).toBe(0);
  });

  it("sets pct=1 for peak hour, pct=0 for empty hours", () => {
    const entries = [
      makeEntry("2026-05-01T14:00:00.000Z"),
      makeEntry("2026-05-01T14:00:00.000Z"),
      makeEntry("2026-05-01T16:00:00.000Z"),
    ];
    const result = buildHourHeatmap(entries);
    expect(result[14].pct).toBe(1);
    expect(result[16].pct).toBe(0.5);
    expect(result[0].pct).toBe(0);
  });

  it("returns all pct=0 for empty input", () => {
    expect(buildHourHeatmap([]).every(b => b.pct === 0 && b.count === 0)).toBe(true);
  });
});

describe("buildWeekdayDistribution", () => {
  it("returns exactly 7 entries for days 0–6", () => {
    const result = buildWeekdayDistribution([]);
    expect(result).toHaveLength(7);
    expect(result.map(b => b.day)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("counts entries by UTC weekday (0=Sunday)", () => {
    // 2026-05-04 is a Monday (UTC day 1)
    // 2026-05-10 is a Sunday (UTC day 0)
    const entries = [
      makeEntry("2026-05-04T12:00:00.000Z"), // Monday
      makeEntry("2026-05-04T18:00:00.000Z"), // Monday
      makeEntry("2026-05-10T10:00:00.000Z"), // Sunday
    ];
    const result = buildWeekdayDistribution(entries);
    expect(result[1].count).toBe(2); // Monday
    expect(result[0].count).toBe(1); // Sunday
    expect(result[2].count).toBe(0); // Tuesday
  });

  it("computes pct as share of total entries", () => {
    const entries = [
      makeEntry("2026-05-04T12:00:00.000Z"), // Monday
      makeEntry("2026-05-04T18:00:00.000Z"), // Monday
    ];
    const result = buildWeekdayDistribution(entries);
    expect(result[1].pct).toBeCloseTo(1.0);
    expect(result[0].pct).toBe(0);
  });

  it("labels are German day names starting with Sonntag", () => {
    const result = buildWeekdayDistribution([]);
    expect(result[0].label).toBe("Sonntag");
    expect(result[1].label).toBe("Montag");
    expect(result[6].label).toBe("Samstag");
  });
});

describe("buildTopActiveDays", () => {
  it("returns at most limit entries", () => {
    const entries = [
      makeEntry("2026-05-01T10:00:00.000Z"),
      makeEntry("2026-05-02T10:00:00.000Z"),
      makeEntry("2026-05-03T10:00:00.000Z"),
    ];
    expect(buildTopActiveDays(entries, [], 2)).toHaveLength(2);
  });

  it("sorts by count descending", () => {
    const entries = [
      makeEntry("2026-05-01T10:00:00.000Z"),
      makeEntry("2026-05-02T10:00:00.000Z"),
      makeEntry("2026-05-02T11:00:00.000Z"),
    ];
    const result = buildTopActiveDays(entries, [], 3);
    expect(result[0].date).toBe("2026-05-02");
    expect(result[0].count).toBe(2);
    expect(result[1].date).toBe("2026-05-01");
  });

  it("picks outputTokens from claudeRows by date", () => {
    const entries = [makeEntry("2026-05-01T10:00:00.000Z")];
    const rows = [makeRow("2026-05-01", 500)];
    const result = buildTopActiveDays(entries, rows, 5);
    expect(result[0].outputTokens).toBe(500);
  });

  it("returns 0 outputTokens if no matching row", () => {
    const entries = [makeEntry("2026-05-01T10:00:00.000Z")];
    const result = buildTopActiveDays(entries, [], 5);
    expect(result[0].outputTokens).toBe(0);
  });

  it("returns entries in stable order when counts tie", () => {
    const entries = [
      makeEntry("2026-05-01T10:00:00.000Z"),
      makeEntry("2026-05-02T10:00:00.000Z"),
    ];
    const result = buildTopActiveDays(entries, [], 5);
    expect(result).toHaveLength(2);
    expect(result[0].count).toBe(1);
    expect(result[1].count).toBe(1);
  });
});
