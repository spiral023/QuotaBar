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

  it("folds models below the share threshold into 'Other'", () => {
    const withTiny = [
      ...days,
      day("2026-01-05", "gpt-5.4-mini", { outputTokens: 1 }),
    ];
    const s = calc.buildStack(withTiny, "output", "daily", 0.05);
    expect(s.series.map((x: any) => x.model)).toContain("Other");
    expect(s.series.map((x: any) => x.model)).not.toContain("gpt-5.4-mini");
    expect(s.othersGrouped).toEqual(["gpt-5.4-mini"]);
  });

  it("'Other' is always the last series", () => {
    const withTiny = [
      ...days,
      day("2026-01-05", "gpt-5.4-mini", { outputTokens: 1 }),
    ];
    const s = calc.buildStack(withTiny, "output", "daily", 0.05);
    expect(s.series[s.series.length - 1].model).toBe("Other");
  });
});

describe("buildStack granularity (monthly/hourly)", () => {
  it("groups by month when granularity is 'monthly'", () => {
    const days = [
      day("2026-01-05", "claude-opus-4-8", { outputTokens: 30 }),
      day("2026-01-20", "claude-opus-4-8", { outputTokens: 20 }),
      day("2026-02-03", "claude-opus-4-8", { outputTokens: 10 }),
    ];
    const s = calc.buildStack(days, "output", "monthly", 0);
    expect(s.buckets).toEqual(["2026-01", "2026-02"]);
    expect(s.series[0].values).toEqual([50, 10]);
  });

  it("uses the date verbatim as bucket when granularity is 'hourly'", () => {
    const cells = [
      day("2026-01-05 09:00", "claude-opus-4-8", { outputTokens: 5 }),
      day("2026-01-05 10:00", "claude-opus-4-8", { outputTokens: 7 }),
    ];
    const s = calc.buildStack(cells, "output", "hourly", 0);
    expect(s.buckets).toEqual(["2026-01-05 09:00", "2026-01-05 10:00"]);
    expect(s.series[0].values).toEqual([5, 7]);
  });
});

describe("filterRange / previousRange", () => {
  const days = [
    day("2026-03-01", "gpt-5.5"),
    day("2026-03-05", "gpt-5.5"),
    day("2026-03-10", "gpt-5.5"),
    day("2026-03-20", "gpt-5.5"),
  ];

  it("filterRange keeps days within [from, to] inclusive", () => {
    expect(calc.filterRange(days, "2026-03-05", "2026-03-10").map((d: any) => d.date))
      .toEqual(["2026-03-05", "2026-03-10"]);
  });

  it("previousRange returns the equal-length window immediately before", () => {
    // [03-05 .. 03-10] = 6 Tage → Vorperiode [02-27 .. 03-04]
    const prev = calc.previousRange(days, "2026-03-05", "2026-03-10");
    expect(prev.map((d: any) => d.date)).toEqual(["2026-03-01"]);
  });

  it("previousRange is empty without a range", () => {
    expect(calc.previousRange(days, "", "")).toEqual([]);
  });
});

describe("buildRateSeries", () => {
  it("computes effective $/MTok per provider and total per bucket", () => {
    const days = [
      // Tag 1: Claude $2 / 1M = $2/MTok; Codex $1 / 2M = $0.5/MTok
      day("2026-03-01", "claude-opus-4-8", { totalTokens: 1_000_000, costUSD: 2 }),
      day("2026-03-01", "gpt-5.5",         { totalTokens: 2_000_000, costUSD: 1 }),
      // Tag 2: nur Claude $9 / 3M = $3/MTok
      day("2026-03-02", "claude-opus-4-8", { totalTokens: 3_000_000, costUSD: 9 }),
    ];
    const r = calc.buildRateSeries(days, "daily");
    expect(r.buckets).toEqual(["2026-03-01", "2026-03-02"]);
    expect(r.claude[0]).toBeCloseTo(2);
    expect(r.codex[0]).toBeCloseTo(0.5);
    expect(r.claude[1]).toBeCloseTo(3);
    // Codex hatte an Tag 2 keine Tokens → Lücke (null)
    expect(r.codex[1]).toBeNull();
    // Gesamt Tag 1: $3 / 3M = $1/MTok
    expect(r.total[0]).toBeCloseTo(1);
  });

  it("yields null for buckets without tokens (chart gap)", () => {
    const days = [day("2026-03-01", "claude-opus-4-8", { totalTokens: 0, costUSD: 0 })];
    const r = calc.buildRateSeries(days, "daily");
    expect(r.claude[0]).toBeNull();
    expect(r.total[0]).toBeNull();
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

  describe("bestValue mit Mindest-Token-Anteil", () => {
    // Haiku: top Score/$ (40/1=40), aber nur ~1 % Token-Anteil.
    // Opus: 61/3 ≈ 20.3, ~99 % Token-Anteil.
    const days = [
      day("2026-03-01", "claude-opus-4-8",  { totalTokens: 1_000_000, costUSD: 3 }),
      day("2026-03-02", "claude-haiku-4-5", { totalTokens: 10_000,    costUSD: 0.01 }),
    ];
    const bench = { "claude-opus-4-8": 61, "claude-haiku-4-5": 40 };

    it("ohne Schwelle gewinnt das kaum genutzte Haiku auf Score/$", () => {
      const k = calc.computeKpis(days, [], bench);
      expect(k.bestValue.model).toBe("claude-haiku-4-5");
    });

    it("ab 5 % Schwelle fällt Haiku raus → Opus gewinnt", () => {
      const k = calc.computeKpis(days, [], bench, 5);
      expect(k.bestValue.model).toBe("claude-opus-4-8");
    });

    it("Schwelle 0 verhält sich wie ohne Filter (Default)", () => {
      const k0 = calc.computeKpis(days, [], bench, 0);
      const kDef = calc.computeKpis(days, [], bench);
      expect(k0.bestValue.model).toBe(kDef.bestValue.model);
    });
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

  it("berechnet tokenSharePct je Modell (Anteil an Gesamt-Tokens)", () => {
    const rows = calc.tableRows([
      day("2026-03-01", "claude-opus-4-8", { totalTokens: 900_000, costUSD: 9 }),
      day("2026-03-01", "gpt-5.5",         { totalTokens: 100_000, costUSD: 1 }),
    ], BENCH);
    const opus = rows.find((r) => r.model === "claude-opus-4-8")!;
    const gpt = rows.find((r) => r.model === "gpt-5.5")!;
    expect(opus.tokenSharePct).toBeCloseTo(90);
    expect(gpt.tokenSharePct).toBeCloseTo(10);
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

  it("blendet Modelle unter dem Mindest-Token-Anteil aus", () => {
    const rows = calc.tableRows([
      day("2026-03-01", "claude-opus-4-8",  { totalTokens: 990_000, costUSD: 3 }),
      day("2026-03-01", "claude-haiku-4-5", { totalTokens: 10_000,  costUSD: 0.01 }),
    ], { "claude-opus-4-8": 61, "claude-haiku-4-5": 40 });
    // Haiku ~1 % → ab 5 % Schwelle nicht mehr im Scatter.
    const all = calc.scatterPoints(rows);
    const filtered = calc.scatterPoints(rows, 5);
    expect(all.map((p: any) => p.model).sort()).toEqual(["claude-haiku-4-5", "claude-opus-4-8"]);
    expect(filtered.map((p: any) => p.model)).toEqual(["claude-opus-4-8"]);
  });

  it("colors visible points by value: cheap high-score green, expensive low-score red", () => {
    const pts = calc.scatterPoints([
      { model: "best", provider: "codex", effPerMTok: 1, score: 90, sharePct: 10 },
      { model: "mixed", provider: "codex", effPerMTok: 5, score: 70, sharePct: 10 },
      { model: "worst", provider: "codex", effPerMTok: 9, score: 50, sharePct: 10 },
    ]);

    expect(pts.map((p: any) => p.valueColor)).toEqual(["#52d017", "#ff9f1a", "#ff4b5c"]);
  });

  it("keeps scatter bubble colors tied to provider brand colors", () => {
    const pts = [
      { provider: "claude" },
      { provider: "codex" },
    ];
    const colorForProvider = (provider: string) => provider === "claude" ? "#DA785B" : "#4B55C8";

    expect(calc.scatterBubbleColors(pts, colorForProvider)).toEqual({
      backgroundColor: ["#DA785BCC", "#4B55C8CC"],
      borderColor: ["#DA785B", "#4B55C8"],
    });
  });

  it("colors score axis text from low red through yellow to high green", () => {
    const scale = calc.scatterAxisColorScale([
      { x: 1, y: 50 },
      { x: 5, y: 70 },
      { x: 9, y: 90 },
    ]);

    expect(scale.scoreColor(50)).toBe("#ff4b5c");
    expect(scale.scoreColor(70)).toBe("#ffd21a");
    expect(scale.scoreColor(90)).toBe("#52d017");
  });

  it("colors cost axis text from cheap green through yellow to expensive red", () => {
    const scale = calc.scatterAxisColorScale([
      { x: 1, y: 50 },
      { x: 5, y: 70 },
      { x: 9, y: 90 },
    ]);

    expect(scale.costColor(1)).toBe("#52d017");
    expect(scale.costColor(5)).toBe("#ffd21a");
    expect(scale.costColor(9)).toBe("#ff4b5c");
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

describe("providerCostBreakdown", () => {
  const days = [
    day("2026-01-05", "claude-opus-4-8", {
      inputTokens: 100_000, outputTokens: 50_000, cacheReadTokens: 200_000, cacheCreationTokens: 10_000,
      totalTokens: 360_000, costUSD: 6,
      inputCostUSD: 1, outputCostUSD: 4, cacheReadCostUSD: 0.5, cacheCreationCostUSD: 0.5,
    }),
    day("2026-01-05", "gpt-5.5", {
      inputTokens: 300_000, outputTokens: 100_000, cacheReadTokens: 0, cacheCreationTokens: 0,
      totalTokens: 400_000, costUSD: 2,
      inputCostUSD: 0.5, outputCostUSD: 1.5, cacheReadCostUSD: 0, cacheCreationCostUSD: 0,
    }),
  ];

  it("je Provider ein Block, nach Gesamtkosten absteigend", () => {
    const res = calc.providerCostBreakdown(days);
    expect(res.map((p) => p.provider)).toEqual(["claude", "codex"]);
  });

  it("Σ Typ-Kosten == Gesamtkosten je Provider", () => {
    const res = calc.providerCostBreakdown(days);
    for (const p of res) {
      const sum = p.rows.reduce((s, r) => s + r.costUSD, 0);
      expect(sum).toBeCloseTo(p.totalCostUSD, 9);
    }
  });

  it("blendet Token-Typen mit 0 Tokens aus (Codex hat keinen Cache)", () => {
    const codex = calc.providerCostBreakdown(days).find((p) => p.provider === "codex")!;
    expect(codex.rows.map((r) => r.key)).toEqual(["input", "output"]);
  });

  it("perMTok je Zeile = Kosten/Tokens·1e6; Gesamt = blended Eigenrate", () => {
    const claude = calc.providerCostBreakdown(days).find((p) => p.provider === "claude")!;
    const output = claude.rows.find((r) => r.key === "output")!;
    // Output: $4 / 50k = $80 / MTok
    expect(output.perMTok).toBeCloseTo(80, 6);
    // Gesamt: $6 / 360k = $16.667 / MTok
    expect(claude.effPerMTok).toBeCloseTo((6 / 360_000) * 1e6, 6);
  });

  it("tokenPct je Zeile = Anteil an Gesamt-Tokens des Providers", () => {
    const claude = calc.providerCostBreakdown(days).find((p) => p.provider === "claude")!;
    // Cache Read: 200k / 360k ≈ 55.56 %
    expect(claude.rows.find((r) => r.key === "cacheRead")!.tokenPct).toBeCloseTo((200_000 / 360_000) * 100, 6);
    // Σ Anteile == 100 %
    const sum = claude.rows.reduce((s, r) => s + r.tokenPct, 0);
    expect(sum).toBeCloseTo(100, 6);
  });

  it("hasCostBreakdown=false, wenn keine Per-Typ-Kosten geliefert wurden", () => {
    const stale = [day("2026-01-05", "claude-opus-4-8", { totalTokens: 1e6, costUSD: 5 })];
    const res = calc.providerCostBreakdown(stale);
    expect(res[0].hasCostBreakdown).toBe(false);
    expect(res[0].totalCostUSD).toBeCloseTo(5, 9);
  });

  it("leeres Fenster → leeres Array", () => {
    expect(calc.providerCostBreakdown([])).toEqual([]);
  });
});
