import { describe, it, expect } from "vitest";
import * as calc from "../src/renderer/tabs/models-calc";
import {
  filterWindow,
  previousWindow,
  metricOf,
  isoWeek,
  type Day,
} from "../src/renderer/tabs/models-calc";

function day(date: string, model: string, over: Partial<Day> = {}): Day {
  return {
    date,
    model,
    provider: model.startsWith("claude") ? "claude" : "codex",
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 150,
    costUSD: 1,
    ...over,
  };
}

describe("filterWindow", () => {
  const days = [
    day("2026-01-01", "gpt-5.5"),
    day("2026-03-01", "gpt-5.5"),
    day("2026-03-10", "gpt-5.5"),
  ];

  it("'all' returns everything", () => {
    expect(filterWindow(days, "all", "2026-03-10")).toHaveLength(3);
  });

  it("'30d' keeps the last 30 days including today", () => {
    const result = filterWindow(days, "30d", "2026-03-10");
    expect(result.map((d: Day) => d.date)).toEqual(["2026-03-01", "2026-03-10"]);
  });

  it("previousWindow returns the same-length window before", () => {
    const prev = previousWindow(days, "30d", "2026-03-10");
    expect(prev).toHaveLength(0);
  });
});

describe("metricOf", () => {
  const d = day("2026-01-01", "gpt-5.5", {
    inputTokens: 1,
    outputTokens: 2,
    cacheCreationTokens: 3,
    cacheReadTokens: 4,
    totalTokens: 10,
    costUSD: 5,
  });

  it("maps every metric key", () => {
    expect(metricOf(d, "input")).toBe(1);
    expect(metricOf(d, "output")).toBe(2);
    expect(metricOf(d, "cacheCreation")).toBe(3);
    expect(metricOf(d, "cacheRead")).toBe(4);
    expect(metricOf(d, "total")).toBe(10);
    expect(metricOf(d, "cost")).toBe(5);
  });
});

describe("isoWeek", () => {
  it("matches the reportService ISO week semantics", () => {
    expect(isoWeek("2026-01-01")).toBe("2026-W01");
    expect(isoWeek("2025-12-29")).toBe("2026-W01");
    expect(isoWeek("2025-09-24")).toBe("2025-W39");
  });
});

describe("buildStack", () => {
  const days = [
    day("2026-01-05", "claude-opus-4-8", { outputTokens: 80 }),
    day("2026-01-05", "gpt-5.5", { outputTokens: 20 }),
    day("2026-01-12", "claude-opus-4-8", { outputTokens: 50 }),
  ];

  it("groups daily when granularity is 'daily'", () => {
    const s = calc.buildStack(days, "output", "daily", 0);
    expect(s.buckets).toEqual(["2026-01-05", "2026-01-12"]);
    const opus = s.series.find((x: any) => x.model === "claude-opus-4-8");
    expect(opus.values).toEqual([80, 50]);
  });

  it("groups by ISO week when granularity is 'weekly'", () => {
    const s = calc.buildStack(days, "output", "weekly", 0);
    expect(s.buckets).toEqual(["2026-W02", "2026-W03"]);
  });

  it("folds models below the share threshold into 'Andere'", () => {
    const withTiny = [
      ...days,
      day("2026-01-05", "gpt-5.4-mini", { outputTokens: 1 }),
    ];
    const s = calc.buildStack(withTiny, "output", "daily", 0.05);
    expect(s.series.map((x: any) => x.model)).toContain("Andere");
    expect(s.series.map((x: any) => x.model)).not.toContain("gpt-5.4-mini");
    expect(s.othersGrouped).toEqual(["gpt-5.4-mini"]);
  });

  it("'Andere' is always the last series", () => {
    const withTiny = [
      ...days,
      day("2026-01-05", "gpt-5.4-mini", { outputTokens: 1 }),
    ];
    const s = calc.buildStack(withTiny, "output", "daily", 0.05);
    expect(s.series[s.series.length - 1].model).toBe("Andere");
  });
});

describe("modelColorOrder", () => {
  it("orders models by first appearance date", () => {
    const days2 = [
      day("2026-02-01", "gpt-5.5"),
      day("2026-01-01", "claude-opus-4-8"),
      day("2026-01-15", "gpt-5.4"),
    ];
    expect(calc.modelColorOrder(days2)).toEqual([
      "claude-opus-4-8",
      "gpt-5.4",
      "gpt-5.5",
    ]);
  });
});
