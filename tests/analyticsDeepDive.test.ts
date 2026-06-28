import { describe, it, expect } from "vitest";
import type { ReportRow } from "../src/reports/types";
import type { ClaudeUsageEntry } from "../src/pricing/jsonl-reader";
import type { CodexTokenEvent } from "../src/pricing/codex-log-reader";
import {
  buildHourHeatmap,
  buildWeekdayDistribution,
  buildTopActiveDays,
  buildWeeklySummary,
  buildCostEfficiency,
  computeActiveHours,
  buildSessionStats,
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

// Erzeugt einen ISO-Timestamp aus LOKALEN Zeitkomponenten. Die Builder bucketen
// nach Lokalzeit; so bleiben Stunden-/Wochentags-/Tagesschlüssel-Assertions in
// jeder Zeitzone (z. B. CI in UTC) deterministisch.
function localIso(y: number, mo: number, d: number, h = 0, mi = 0): string {
  return new Date(y, mo - 1, d, h, mi).toISOString();
}

describe("buildHourHeatmap", () => {
  it("returns exactly 24 entries for hours 0–23", () => {
    const result = buildHourHeatmap([]);
    expect(result).toHaveLength(24);
    expect(result.map(b => b.hour)).toEqual(Array.from({ length: 24 }, (_, i) => i));
  });

  it("counts entries by local hour", () => {
    const entries = [
      makeEntry(localIso(2026, 5, 1, 14, 30)),
      makeEntry(localIso(2026, 5, 1, 14, 59)),
      makeEntry(localIso(2026, 5, 1, 16, 0)),
    ];
    const result = buildHourHeatmap(entries);
    expect(result[14].count).toBe(2);
    expect(result[16].count).toBe(1);
    expect(result[0].count).toBe(0);
  });

  it("sets pct=1 for peak hour, pct=0 for empty hours", () => {
    const entries = [
      makeEntry(localIso(2026, 5, 1, 14, 0)),
      makeEntry(localIso(2026, 5, 1, 14, 0)),
      makeEntry(localIso(2026, 5, 1, 16, 0)),
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

  it("counts entries by local weekday (0=Sunday)", () => {
    // 2026-05-04 ist ein Montag (Tag 1), 2026-05-10 ein Sonntag (Tag 0)
    const entries = [
      makeEntry(localIso(2026, 5, 4, 12)), // Montag
      makeEntry(localIso(2026, 5, 4, 18)), // Montag
      makeEntry(localIso(2026, 5, 10, 10)), // Sonntag
    ];
    const result = buildWeekdayDistribution(entries);
    expect(result[1].count).toBe(2); // Montag
    expect(result[0].count).toBe(1); // Sonntag
    expect(result[2].count).toBe(0); // Dienstag
  });

  it("computes pct as share of total entries", () => {
    const entries = [
      makeEntry(localIso(2026, 5, 4, 12)), // Montag
      makeEntry(localIso(2026, 5, 4, 18)), // Montag
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
      makeEntry(localIso(2026, 5, 1, 10)),
      makeEntry(localIso(2026, 5, 2, 10)),
      makeEntry(localIso(2026, 5, 3, 10)),
    ];
    expect(buildTopActiveDays(entries, [], 2)).toHaveLength(2);
  });

  it("sorts by count descending", () => {
    const entries = [
      makeEntry(localIso(2026, 5, 1, 10)),
      makeEntry(localIso(2026, 5, 2, 10)),
      makeEntry(localIso(2026, 5, 2, 11)),
    ];
    const result = buildTopActiveDays(entries, [], 3);
    expect(result[0].date).toBe("2026-05-02");
    expect(result[0].count).toBe(2);
    expect(result[1].date).toBe("2026-05-01");
  });

  it("picks outputTokens from claudeRows by date", () => {
    const entries = [makeEntry(localIso(2026, 5, 1, 10))];
    const rows = [makeRow("2026-05-01", 500)];
    const result = buildTopActiveDays(entries, rows, 5);
    expect(result[0].outputTokens).toBe(500);
  });

  it("returns 0 outputTokens if no matching row", () => {
    const entries = [makeEntry(localIso(2026, 5, 1, 10))];
    const result = buildTopActiveDays(entries, [], 5);
    expect(result[0].outputTokens).toBe(0);
  });

  it("returns entries in stable order when counts tie", () => {
    const entries = [
      makeEntry(localIso(2026, 5, 1, 10)),
      makeEntry(localIso(2026, 5, 2, 10)),
    ];
    const result = buildTopActiveDays(entries, [], 5);
    expect(result).toHaveLength(2);
    expect(result[0].count).toBe(1);
    expect(result[1].count).toBe(1);
  });
});

function makeCodexEvent(isoTimestamp: string): CodexTokenEvent {
  return {
    timestamp: isoTimestamp, model: "gpt-5.5", isFallback: false,
    session: "s1", directory: "/home",
    inputTokens: 100, cachedInputTokens: 0, outputTokens: 50,
    reasoningOutputTokens: 0, totalTokens: 150,
  };
}

describe("buildWeeklySummary", () => {
  it("groups daily rows by Monday-start week", () => {
    // 2026-05-04 = Monday, 2026-05-05 = Tuesday (same week)
    // 2026-05-11 = Monday (next week)
    const rows = [
      makeRow("2026-05-04", 0),
      makeRow("2026-05-05", 0),
      makeRow("2026-05-11", 0),
    ];
    const result = buildWeeklySummary(rows, [], [], []);
    expect(result).toHaveLength(2);
    expect(result[0].weekStart).toBe("2026-05-04");
    expect(result[1].weekStart).toBe("2026-05-11");
  });

  it("sums claudeTokens and claudeCostUSD from rows", () => {
    const rows = [
      { ...makeRow("2026-05-04", 200), totalTokens: 500, costUSD: 3.5 } as ReportRow,
      { ...makeRow("2026-05-05", 100), totalTokens: 300, costUSD: 1.5 } as ReportRow,
    ];
    const result = buildWeeklySummary(rows, [], [], []);
    expect(result[0].claudeTokens).toBe(800);
    expect(result[0].claudeCostUSD).toBeCloseTo(5.0);
  });

  it("counts claudeMessages from entries", () => {
    const entries = [
      makeEntry("2026-05-04T10:00:00.000Z"),
      makeEntry("2026-05-04T11:00:00.000Z"),
      makeEntry("2026-05-11T10:00:00.000Z"),
    ];
    const result = buildWeeklySummary([], [], entries, []);
    const week1 = result.find(w => w.weekStart === "2026-05-04");
    expect(week1?.claudeMessages).toBe(2);
  });

  it("counts codexEvents from codex events", () => {
    const events = [
      makeCodexEvent("2026-05-04T10:00:00.000Z"),
      makeCodexEvent("2026-05-04T12:00:00.000Z"),
    ];
    const result = buildWeeklySummary([], [], [], events);
    expect(result[0].codexEvents).toBe(2);
  });

  it("sums codexTokens from codexRows", () => {
    const rows = [
      { ...makeRow("2026-05-04", 0), totalTokens: 400 } as ReportRow,
    ];
    const result = buildWeeklySummary([], rows, [], []);
    expect(result[0].codexTokens).toBe(400);
  });

  it("returns weeks sorted oldest first", () => {
    const rows = [makeRow("2026-05-11", 0), makeRow("2026-05-04", 0)];
    const result = buildWeeklySummary(rows, [], [], []);
    expect(result[0].weekStart < result[1].weekStart).toBe(true);
  });
});

describe("buildCostEfficiency", () => {
  it("computes costPer1kOutputTokens", () => {
    const r = buildCostEfficiency(10, 100_000, 5);
    expect(r.costPer1kOutputTokens).toBeCloseTo(0.1);
  });

  it("returns 0 costPer1kOutputTokens when outputTokens=0", () => {
    expect(buildCostEfficiency(10, 0, 5).costPer1kOutputTokens).toBe(0);
  });

  it("computes costPerActiveHour", () => {
    const r = buildCostEfficiency(50, 1_000_000, 10);
    expect(r.costPerActiveHour).toBeCloseTo(5);
  });

  it("returns 0 costPerActiveHour when totalHours=0", () => {
    expect(buildCostEfficiency(10, 100_000, 0).costPerActiveHour).toBe(0);
  });

  it("returns exactly 3 ROI tier entries", () => {
    expect(buildCostEfficiency(200, 1_000_000, 10).roiByTier).toHaveLength(3);
  });

  it("computes ROI correctly for Pro tier", () => {
    const r = buildCostEfficiency(200, 1_000_000, 10);
    const pro = r.roiByTier.find(t => t.tier === "Claude Pro")!;
    expect(pro.price).toBe(20);
    expect(pro.roi).toBeCloseTo(10);
  });

  it("computes subCostPerActiveHour from prorated subscription", () => {
    // $20/mo sub, prorated to 7 days = $20*7/30 ≈ $4.67; 10 active hours → ≈$0.467/h
    const r = buildCostEfficiency(50, 1_000_000, 10, 20 * 7 / 30);
    expect(r.subCostPerActiveHour).toBeCloseTo(20 * 7 / 30 / 10);
  });

  it("returns 0 subCostPerActiveHour when activeHours=0", () => {
    expect(buildCostEfficiency(10, 100_000, 0, 5).subCostPerActiveHour).toBe(0);
  });

  it("returns 0 subCostPerActiveHour when no subscription configured", () => {
    expect(buildCostEfficiency(10, 100_000, 5, 0).subCostPerActiveHour).toBe(0);
  });

  it("backward-compatible: subCostPerActiveHour=0 when 4th arg omitted", () => {
    expect(buildCostEfficiency(10, 100_000, 5).subCostPerActiveHour).toBe(0);
  });
});

function makeSessionEntry(isoTimestamp: string, session: string, project = "p1"): ClaudeUsageEntry {
  return { ...makeEntry(isoTimestamp), session, project };
}

describe("computeActiveHours", () => {
  it("returns 0 for empty entries", () => {
    expect(computeActiveHours([])).toBe(0);
  });

  it("sums continuous activity within one block", () => {
    const entries = [
      makeEntry("2026-05-01T10:00:00.000Z"),
      makeEntry("2026-05-01T10:10:00.000Z"),
      makeEntry("2026-05-01T10:20:00.000Z"),
    ];
    expect(computeActiveHours(entries)).toBeCloseTo(20 / 60);
  });

  it("excludes idle gaps longer than 30 minutes", () => {
    const entries = [
      makeEntry("2026-05-01T10:00:00.000Z"),
      makeEntry("2026-05-01T10:10:00.000Z"),
      // 3h idle — same session, but should not count as work time
      makeEntry("2026-05-01T13:10:00.000Z"),
      makeEntry("2026-05-01T13:20:00.000Z"),
    ];
    expect(computeActiveHours(entries)).toBeCloseTo(20 / 60);
  });

  it("does not double-count overlapping parallel sessions", () => {
    const entries = [
      makeSessionEntry("2026-05-01T10:00:00.000Z", "s1"),
      makeSessionEntry("2026-05-01T10:30:00.000Z", "s1"),
      makeSessionEntry("2026-05-01T11:00:00.000Z", "s1"),
      makeSessionEntry("2026-05-01T10:00:00.000Z", "s2", "p2"),
      makeSessionEntry("2026-05-01T10:30:00.000Z", "s2", "p2"),
      makeSessionEntry("2026-05-01T11:00:00.000Z", "s2", "p2"),
    ];
    expect(computeActiveHours(entries)).toBeCloseTo(1);
  });

  it("credits a minimum of 1 minute per activity block", () => {
    const entries = [makeEntry("2026-05-01T10:00:00.000Z")];
    expect(computeActiveHours(entries)).toBeCloseTo(1 / 60);
  });

  it("handles unsorted input", () => {
    const entries = [
      makeEntry("2026-05-01T10:20:00.000Z"),
      makeEntry("2026-05-01T10:00:00.000Z"),
      makeEntry("2026-05-01T10:10:00.000Z"),
    ];
    expect(computeActiveHours(entries)).toBeCloseTo(20 / 60);
  });

  it("returns unrounded hours suitable for division", () => {
    const entries = [
      makeEntry("2026-05-01T10:00:00.000Z"),
      makeEntry("2026-05-01T10:03:00.000Z"),
    ];
    // 3 minutes = 0.05h — must not collapse to 0 through rounding
    expect(computeActiveHours(entries)).toBeCloseTo(0.05);
  });
});

describe("buildSessionStats", () => {
  it("excludes single-entry sessions from avgMinutes and totalHours", () => {
    const entries = [
      makeSessionEntry("2026-05-01T10:00:00.000Z", "multi"),
      makeSessionEntry("2026-05-01T11:00:00.000Z", "multi"),
      makeSessionEntry("2026-05-01T12:00:00.000Z", "single"),
    ];

    const stats = buildSessionStats(entries, 1);

    expect(stats.count).toBe(2);
    expect(stats.avgMinutes).toBe(60);
    expect(stats.totalHours).toBe(1);
  });
});
