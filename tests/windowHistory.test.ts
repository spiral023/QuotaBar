import { describe, expect, it } from "vitest";
import {
  buildWindowHistory,
  buildFiveHourPressure,
  type HistoryObservation,
  type PressureDist,
} from "../src/usage/windowHistory";
import { mergeWindowHistory, type WindowHistoryEntry } from "../src/usage/windowHistoryStore";

const R1 = "2026-06-08T00:00:00.000Z";
const R2 = "2026-06-15T00:00:00.000Z";
const NOW = Date.parse("2026-06-10T00:00:00Z");

function obs(
  ts: string,
  fivePct: number,
  fiveResetsAt: string | null,
  weeklyPct: number,
  weeklyResetsAt: string | null,
  provider = "claude",
): HistoryObservation {
  return { provider, ts, fivePct, fiveResetsAt, weeklyPct, weeklyResetsAt };
}

describe("buildWindowHistory", () => {
  it("zählt 5h-Fenster mit >5 % und berechnet maxWindows je Periode", () => {
    const FA = "2026-06-02T05:00:00Z";
    const FB = "2026-06-02T10:00:00Z";
    const data = [
      obs("2026-06-02T00:00:00Z", 10, FA, 2, R1),
      obs("2026-06-02T04:00:00Z", 40, FA, 5, R1),
      obs("2026-06-02T05:30:00Z", 8, FB, 6, R1),
      obs("2026-06-02T09:00:00Z", 35, FB, 9, R1),
    ];
    const result = buildWindowHistory(data, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].provider).toBe("claude");
    expect(result[0].weekEnd).toBe(R1);
    expect(result[0].usedWindows).toBe(2); // FA peak 40, FB peak 35
    // sumFive = 30 + 27 = 57, sumWeekly = 3 + 3 = 6 → 9.5
    expect(result[0].maxWindows).toBeCloseTo(9.5, 5);
    expect(result[0].bonus).toBe(false);
  });

  it("ignoriert 5h-Fenster unter der 5 %-Schwelle", () => {
    const FA = "2026-06-02T05:00:00Z";
    const FB = "2026-06-02T10:00:00Z";
    const data = [
      obs("2026-06-02T00:00:00Z", 1, FA, 1, R1),
      obs("2026-06-02T04:00:00Z", 3, FA, 2, R1), // Peak 3 < 5 → nicht gezählt
      obs("2026-06-02T05:30:00Z", 10, FB, 7, R1),
      obs("2026-06-02T09:00:00Z", 60, FB, 13, R1),
    ];
    const result = buildWindowHistory(data, NOW);
    expect(result[0].usedWindows).toBe(1); // nur FB
  });

  it("schließt die laufende Periode (Ende in der Zukunft) aus", () => {
    const data = [
      obs("2026-06-02T00:00:00Z", 10, "2026-06-02T05:00:00Z", 5, R1),
      obs("2026-06-02T04:00:00Z", 40, "2026-06-02T05:00:00Z", 12, R1),
      // Folgeperiode endet R2 (> NOW) und ist die letzte → laufend, ausgeschlossen
      obs("2026-06-09T00:00:00Z", 20, "2026-06-09T05:00:00Z", 3, R2),
    ];
    const result = buildWindowHistory(data, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].weekEnd).toBe(R1);
  });

  it("markiert eine Bonus-Periode (Weekly fällt ohne resetsAt-Wechsel)", () => {
    const FA = "2026-06-02T05:00:00Z";
    const FB = "2026-06-04T05:00:00Z";
    const data = [
      obs("2026-06-02T00:00:00Z", 10, FA, 25, R1),
      obs("2026-06-02T04:00:00Z", 40, FA, 30, R1),
      obs("2026-06-04T00:00:00Z", 5, FB, 1, R1), // Weekly 30 → 1, gleiche Periode
      obs("2026-06-04T04:00:00Z", 50, FB, 6, R1),
    ];
    const result = buildWindowHistory(data, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].bonus).toBe(true);
  });

  it("trennt Perioden je Anbieter", () => {
    const data = [
      obs("2026-06-02T00:00:00Z", 10, "2026-06-02T05:00:00Z", 5, R1, "claude"),
      obs("2026-06-02T04:00:00Z", 40, "2026-06-02T05:00:00Z", 12, R1, "claude"),
      obs("2026-06-02T00:00:00Z", 10, "2026-06-02T05:00:00Z", 5, R1, "codex"),
      obs("2026-06-02T04:00:00Z", 40, "2026-06-02T05:00:00Z", 12, R1, "codex"),
    ];
    const result = buildWindowHistory(data, NOW);
    expect(result.map((e) => e.provider).sort()).toEqual(["claude", "codex"]);
  });

  it("fasst Minuten-Drift im resetsAt zu EINER Periode zusammen (Codex-Treppung)", () => {
    // Codex' Weekly-resetsAt rückt beim Übergang in ~2-Min-Schritten vor; das
    // darf NICHT in viele leere Pseudo-Perioden zerfallen.
    const data = [
      obs("2026-06-03T01:00:00Z", 10, "2026-06-03T05:00:00Z", 6, "2026-06-09T01:16:38Z", "codex"),
      obs("2026-06-03T05:00:00Z", 40, "2026-06-03T05:00:00Z", 9, "2026-06-09T01:18:39Z", "codex"),
      obs("2026-06-04T01:00:00Z", 30, "2026-06-04T05:00:00Z", 14, "2026-06-09T01:20:38Z", "codex"),
      obs("2026-06-04T05:00:00Z", 55, "2026-06-04T05:00:00Z", 18, "2026-06-09T01:22:39Z", "codex"),
    ];
    const result = buildWindowHistory(data, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].provider).toBe("codex");
    expect(result[0].usedWindows).toBe(2); // zwei echte 5h-Fenster
  });

  it("trennt Perioden bei echtem 7d-Sprung (Tage auseinander)", () => {
    const data = [
      obs("2026-05-26T01:00:00Z", 10, "2026-05-26T05:00:00Z", 6, "2026-06-01T01:00:00Z", "codex"),
      obs("2026-05-26T05:00:00Z", 40, "2026-05-26T05:00:00Z", 12, "2026-06-01T01:00:00Z", "codex"),
      obs("2026-06-02T01:00:00Z", 10, "2026-06-02T05:00:00Z", 5, "2026-06-08T01:00:00Z", "codex"),
      obs("2026-06-02T05:00:00Z", 40, "2026-06-02T05:00:00Z", 11, "2026-06-08T01:00:00Z", "codex"),
    ];
    const result = buildWindowHistory(data, NOW);
    expect(result).toHaveLength(2); // zwei echte Perioden
  });

  it("setzt maxWindows auf null bei zu wenig Weekly-Bewegung", () => {
    const FA = "2026-06-02T05:00:00Z";
    const data = [
      obs("2026-06-02T00:00:00Z", 10, FA, 1, R1),
      obs("2026-06-02T04:00:00Z", 40, FA, 2, R1), // ΣWeekly = 1 < 5
    ];
    const result = buildWindowHistory(data, NOW);
    expect(result[0].maxWindows).toBeNull();
  });
});

describe("mergeWindowHistory", () => {
  const mk = (provider: string, weekEnd: string, usedWindows: number): WindowHistoryEntry => ({
    provider, weekEnd, weekStart: weekEnd, usedWindows, maxWindows: 8, bonus: false,
  });

  it("vereint, lässt Frischberechnetes gewinnen und sortiert nach weekEnd", () => {
    const stored = [mk("claude", R1, 3), mk("claude", R2, 5)];
    const computed = [mk("claude", R2, 6), mk("claude", "2026-06-22T00:00:00Z", 4)];
    const merged = mergeWindowHistory(stored, computed);
    expect(merged.map((e) => e.weekEnd)).toEqual([R1, R2, "2026-06-22T00:00:00Z"]);
    expect(merged.find((e) => e.weekEnd === R2)?.usedWindows).toBe(6); // frisch gewinnt
    expect(merged.find((e) => e.weekEnd === R1)?.usedWindows).toBe(3); // alt erhalten
  });

  it("hält Anbieter mit gleichem weekEnd getrennt", () => {
    const merged = mergeWindowHistory([mk("claude", R1, 3)], [mk("codex", R1, 4)]);
    expect(merged).toHaveLength(2);
  });
});

describe("buildFiveHourPressure", () => {
  const SINCE = Date.parse("2026-06-01T00:00:00Z");
  const UNTIL = Date.parse("2026-06-30T00:00:00Z");
  const FA = "2026-06-02T05:00:00Z";
  const FB = "2026-06-02T10:00:00Z";
  const FC = "2026-06-02T15:00:00Z";

  it("returns an empty distribution for no observations", () => {
    const r = buildFiveHourPressure([], SINCE, UNTIL, "claude");
    expect(r).toEqual<PressureDist>({
      buckets: { crit: 0, high: 0, mid: 0, low: 0, min: 0 },
      total: 0,
      hotCount: 0,
      worst: null,
    });
  });

  it("segments by fiveResetsAt and buckets each window's peak", () => {
    const data = [
      obs("2026-06-02T00:30:00Z", 20, FA, 2, R1), // window A peak 95 -> crit
      obs("2026-06-02T04:00:00Z", 95, FA, 5, R1),
      obs("2026-06-02T05:30:00Z", 60, FB, 6, R1), // window B peak 60 -> mid
      obs("2026-06-02T09:00:00Z", 40, FB, 9, R1),
    ];
    const r = buildFiveHourPressure(data, SINCE, UNTIL, "claude");
    expect(r.total).toBe(2);
    expect(r.buckets.crit).toBe(1);
    expect(r.buckets.mid).toBe(1);
    expect(r.hotCount).toBe(1);
    expect(r.worst).toEqual({ pct: 95, windowStart: "2026-06-02T00:30:00Z" });
  });

  it("ignores windows whose peak is at or below 5%", () => {
    const data = [
      obs("2026-06-02T00:30:00Z", 3, FA, 1, R1),
      obs("2026-06-02T04:00:00Z", 5, FA, 1, R1), // peak 5 -> not active
    ];
    const r = buildFiveHourPressure(data, SINCE, UNTIL, "claude");
    expect(r.total).toBe(0);
    expect(r.worst).toBeNull();
  });

  it("places boundary values in the upper bucket (>= semantics)", () => {
    const data = [
      obs("2026-06-02T00:30:00Z", 90, FA, 1, R1), // -> crit (>=90)
      obs("2026-06-02T05:30:00Z", 75, FB, 1, R1), // -> high (>=75)
      obs("2026-06-02T10:30:00Z", 50, FC, 1, R1), // -> mid  (>=50)
    ];
    const r = buildFiveHourPressure(data, SINCE, UNTIL, "claude");
    expect(r.buckets).toEqual({ crit: 1, high: 1, mid: 1, low: 0, min: 0 });
  });

  it("excludes windows whose start falls outside [sinceMs, untilMs]", () => {
    const data = [
      obs("2026-05-15T00:30:00Z", 95, FA, 1, R1), // before SINCE
      obs("2026-05-15T04:00:00Z", 95, FA, 1, R1),
    ];
    const r = buildFiveHourPressure(data, SINCE, UNTIL, "claude");
    expect(r.total).toBe(0);
  });

  it("separates providers — only counts the requested provider's windows", () => {
    const data = [
      obs("2026-06-02T00:30:00Z", 95, FA, 1, R1, "claude"),
      obs("2026-06-02T00:30:00Z", 80, FA, 1, R1, "codex"),
    ];
    const claude = buildFiveHourPressure(data, SINCE, UNTIL, "claude");
    const codex = buildFiveHourPressure(data, SINCE, UNTIL, "codex");
    expect(claude.total).toBe(1);
    expect(claude.buckets.crit).toBe(1);
    expect(codex.total).toBe(1);
    expect(codex.buckets.high).toBe(1);
  });

  it("does not split a window when fiveResetsAt is null", () => {
    const data = [
      obs("2026-06-02T00:30:00Z", 30, null, 1, R1),
      obs("2026-06-02T04:00:00Z", 70, null, 1, R1), // same window, peak 70 -> mid
    ];
    const r = buildFiveHourPressure(data, SINCE, UNTIL, "claude");
    expect(r.total).toBe(1);
    expect(r.buckets.mid).toBe(1);
  });
});
