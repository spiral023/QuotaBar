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

const BENCH = { "claude-opus-4-8": 61, "gpt-5.5": 59 };

describe("computeKpis", () => {
  const cur = [
    day("2026-03-01", "claude-opus-4-8", { outputTokens: 100, totalTokens: 1_000_000, costUSD: 3 }),
    day("2026-03-02", "gpt-5.5",         { outputTokens: 300, totalTokens: 1_000_000, costUSD: 1 }),
  ];
  const prev = [
    day("2026-02-01", "claude-opus-4-8", { totalTokens: 1_000_000, costUSD: 8 }),
  ];

  it("counts active models and delta vs previous window", () => {
    const k = calc.computeKpis(cur, prev, BENCH);
    expect(k.activeModels).toBe(2);
    expect(k.activeModelsDelta).toBe(1);
  });

  it("identifies top model by cost and by output", () => {
    const k = calc.computeKpis(cur, prev, BENCH);
    expect(k.topCost.model).toBe("claude-opus-4-8");
    expect(k.topCost.sharePct).toBeCloseTo(75);
    expect(k.topOutput.model).toBe("gpt-5.5");
  });

  it("computes effective $/MTok and delta vs previous window", () => {
    const k = calc.computeKpis(cur, prev, BENCH);
    expect(k.effPerMTok).toBeCloseTo(2);        // $4 / 2M tok × 1M
    expect(k.effPerMTokDeltaPct).toBeCloseTo(-75); // vorher $8/MTok
  });

  it("nulls deltas when previous window is empty (window 'all')", () => {
    const k = calc.computeKpis(cur, [], BENCH);
    expect(k.activeModelsDelta).toBeNull();
    expect(k.effPerMTokDeltaPct).toBeNull();
  });

  it("picks best value model (score per effective $/MTok)", () => {
    const k = calc.computeKpis(cur, prev, BENCH);
    // opus: 61 / 3 ≈ 20.3 — gpt-5.5: 59 / 1 = 59 → gpt-5.5
    expect(k.bestValue.model).toBe("gpt-5.5");
  });

  it("computes top-3 cost concentration", () => {
    const k = calc.computeKpis(cur, prev, BENCH);
    expect(k.top3SharePct).toBe(100); // nur 2 Modelle
  });
});

describe("tableRows", () => {
  const days = [
    day("2026-03-01", "claude-opus-4-8", {
      inputTokens: 100, cacheReadTokens: 300, outputTokens: 50,
      totalTokens: 1_000_000, costUSD: 2,
    }),
    day("2026-03-05", "claude-opus-4-8", {
      inputTokens: 100, cacheReadTokens: 100, outputTokens: 50,
      totalTokens: 1_000_000, costUSD: 2,
    }),
  ];

  it("aggregates per model with first/last usage and cache hit rate", () => {
    const rows = calc.tableRows(days, BENCH);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.firstUsed).toBe("2026-03-01");
    expect(r.lastUsed).toBe("2026-03-05");
    expect(r.cacheHitRate).toBeCloseTo(400 / 600); // cacheRead/(input+cacheRead)
    expect(r.effPerMTok).toBeCloseTo(2);           // $4 / 2M × 1M
    expect(r.score).toBe(61);
    expect(r.scorePerDollar).toBeCloseTo(61 / 2);
  });

  it("sets score and scorePerDollar to null for unknown models", () => {
    const rows = calc.tableRows([day("2026-03-01", "gpt-5-codex-mini")], BENCH);
    expect(rows[0].score).toBeNull();
    expect(rows[0].scorePerDollar).toBeNull();
  });

  it("sorts by cost descending by default", () => {
    const rows = calc.tableRows([
      day("2026-03-01", "gpt-5.5", { costUSD: 1 }),
      day("2026-03-01", "claude-opus-4-8", { costUSD: 9 }),
    ], BENCH);
    expect(rows[0].model).toBe("claude-opus-4-8");
  });
});

describe("scatterPoints", () => {
  it("emits only models with score and effective price", () => {
    const rows = calc.tableRows([
      day("2026-03-01", "claude-opus-4-8", { totalTokens: 1_000_000, costUSD: 3 }),
      day("2026-03-01", "gpt-5-codex-mini"),
    ], BENCH);
    const pts = calc.scatterPoints(rows);
    expect(pts).toHaveLength(1);
    expect(pts[0]).toMatchObject({ model: "claude-opus-4-8", x: 3, y: 61 });
    expect(pts[0].r).toBeGreaterThan(0);
  });
});

describe("adoptionTimeline", () => {
  it("returns per-model month intensities relative to the model's peak month", () => {
    const t = calc.adoptionTimeline([
      day("2026-01-10", "gpt-5.5", { outputTokens: 100 }),
      day("2026-02-10", "gpt-5.5", { outputTokens: 50 }),
    ]);
    expect(t).toHaveLength(1);
    expect(t[0].model).toBe("gpt-5.5");
    expect(t[0].months).toEqual([
      { month: "2026-01", intensity: 1 },
      { month: "2026-02", intensity: 0.5 },
    ]);
  });
});

describe("cacheEfficiency", () => {
  it("computes hit rate and saved USD from pricing rates", () => {
    const days = [day("2026-03-01", "claude-opus-4-8", { inputTokens: 100, cacheReadTokens: 900 })];
    const pricing = { "claude-opus-4-8": { inputPerMTok: 15, cacheReadPerMTok: 1.5 } };
    const e = calc.cacheEfficiency(days, pricing);
    expect(e).toHaveLength(1);
    expect(e[0].hitRate).toBeCloseTo(0.9);
    expect(e[0].savedUSD).toBeCloseTo((900 / 1e6) * (15 - 1.5));
  });

  it("skips models without pricing", () => {
    const days = [day("2026-03-01", "gpt-5.5", { cacheReadTokens: 100 })];
    expect(calc.cacheEfficiency(days, {})).toHaveLength(0);
  });
});

describe("providerRibbon", () => {
  it("returns claude share per bucket", () => {
    const days = [
      day("2026-01-05", "claude-opus-4-8", { outputTokens: 75 }),
      day("2026-01-05", "gpt-5.5",         { outputTokens: 25 }),
    ];
    const r = calc.providerRibbon(days, "output", "daily");
    expect(r).toEqual([{ bucket: "2026-01-05", claudeShare: 0.75 }]);
  });
});
