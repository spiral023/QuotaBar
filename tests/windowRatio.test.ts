import { describe, expect, it } from "vitest";
import {
  computeBudget,
  clearTransients,
  emptyProviderState,
  emptyRatioFile,
  recordObservation,
  WindowRatioTracker,
  MIN_SAMPLE_FIVE_PCT,
  DECAY_CAP_FIVE_PCT,
  type ProviderRatioState,
} from "../src/usage/windowRatio";

function feed(state: ProviderRatioState, pairs: Array<[number, number]>, resetsAt = "2026-06-08T10:00:00Z"): ProviderRatioState {
  let s = state;
  for (const [five, weekly] of pairs) {
    s = recordObservation(s, { fivePct: five, weeklyPct: weekly, fiveResetsAt: resetsAt });
  }
  return s;
}

describe("recordObservation", () => {
  it("akkumuliert ko-okkurrierende positive Deltas", () => {
    const s = feed(emptyProviderState(), [[0, 0], [10, 3], [25, 8]]);
    expect(s.sumFivePct).toBe(25);
    expect(s.sumWeeklyPct).toBe(8);
    expect(s.pairCount).toBe(2);
  });

  it("verwirft Paare mit Δ5h ≤ 0 (Reset oder idle)", () => {
    const s = feed(emptyProviderState(), [[50, 10], [50, 10], [5, 12]]);
    expect(s.sumFivePct).toBe(0);
    expect(s.pairCount).toBe(0);
    expect(s.lastFive).toBe(5);
  });

  it("verwirft Paare mit ΔWeekly < 0 (Weekly-Reset)", () => {
    const s = feed(emptyProviderState(), [[10, 90], [20, 2]]);
    expect(s.sumFivePct).toBe(0);
  });

  it("verwirft Paare bei geändertem fiveHour-resetsAt (Rollover)", () => {
    let s = recordObservation(emptyProviderState(), { fivePct: 80, weeklyPct: 50, fiveResetsAt: "2026-06-08T10:00:00Z" });
    s = recordObservation(s, { fivePct: 90, weeklyPct: 55, fiveResetsAt: "2026-06-08T15:00:00Z" });
    expect(s.sumFivePct).toBe(0);
    expect(s.lastFiveResetsAt).toBe("2026-06-08T15:00:00Z");
  });

  it("akzeptiert Paare ohne resetsAt (Claude liefert es teils nicht)", () => {
    let s = recordObservation(emptyProviderState(), { fivePct: 10, weeklyPct: 5 });
    s = recordObservation(s, { fivePct: 20, weeklyPct: 8 });
    expect(s.sumFivePct).toBe(10);
    expect(s.sumWeeklyPct).toBe(3);
  });

  it("verwirft Paare bei gesättigtem Weekly (≥ 99,5 %)", () => {
    const s = feed(emptyProviderState(), [[10, 100], [30, 100]]);
    expect(s.sumFivePct).toBe(0);
  });

  it("setzt den State bei planType-Wechsel zurück", () => {
    let s = recordObservation(emptyProviderState(), { fivePct: 0, weeklyPct: 0, planType: "pro" });
    s = recordObservation(s, { fivePct: 50, weeklyPct: 20, planType: "pro" });
    expect(s.sumFivePct).toBe(50);
    s = recordObservation(s, { fivePct: 60, weeklyPct: 22, planType: "max" });
    expect(s.sumFivePct).toBe(0);
    expect(s.lastPlanType).toBe("max");
  });

  it("halbiert beide Summen oberhalb des Decay-Deckels", () => {
    let s = emptyProviderState();
    s = { ...s, sumFivePct: DECAY_CAP_FIVE_PCT - 10, sumWeeklyPct: 900, lastFive: 0, lastWeekly: 0 };
    s = recordObservation(s, { fivePct: 50, weeklyPct: 15 });
    expect(s.sumFivePct).toBeCloseTo((DECAY_CAP_FIVE_PCT - 10 + 50) / 2);
    expect(s.sumWeeklyPct).toBeCloseTo(915 / 2);
  });
});

describe("computeBudget", () => {
  it("meldet learning unterhalb der Mindest-Stichprobe", () => {
    const s = { ...emptyProviderState(), sumFivePct: MIN_SAMPLE_FIVE_PCT - 1, sumWeeklyPct: 50 };
    const b = computeBudget(s, 40);
    expect(b.learning).toBe(true);
    if (b.learning) expect(b.sampleFivePct).toBe(MIN_SAMPLE_FIVE_PCT - 1);
  });

  it("meldet learning bei undefined State", () => {
    expect(computeBudget(undefined, 40).learning).toBe(true);
  });

  it("berechnet Fenster pro Woche, verbraucht und übrig", () => {
    const s = { ...emptyProviderState(), sumFivePct: 900, sumWeeklyPct: 300 };
    const b = computeBudget(s, 62);
    expect(b.learning).toBe(false);
    if (!b.learning) {
      expect(b.windowsPerWeek).toBeCloseTo(3);
      expect(b.usedWindows).toBeCloseTo(1.86);
      expect(b.remainingWindows).toBeCloseTo(1.14);
    }
  });

  it("klemmt remainingWindows bei Weekly > 100 % auf 0", () => {
    const s = { ...emptyProviderState(), sumFivePct: 900, sumWeeklyPct: 300 };
    const b = computeBudget(s, 110);
    if (!b.learning) expect(b.remainingWindows).toBe(0);
  });
});

describe("clearTransients", () => {
  it("löscht last-Werte, behält Summen und planType", () => {
    const file = emptyRatioFile();
    file.providers.claude = { ...emptyProviderState(), sumFivePct: 500, sumWeeklyPct: 160, lastFive: 80, lastWeekly: 30, lastFiveResetsAt: "x", lastPlanType: "pro" };
    const out = clearTransients(file);
    expect(out.providers.claude.lastFive).toBeNull();
    expect(out.providers.claude.lastWeekly).toBeNull();
    expect(out.providers.claude.lastFiveResetsAt).toBeNull();
    expect(out.providers.claude.sumFivePct).toBe(500);
    expect(out.providers.claude.lastPlanType).toBe("pro");
  });
});

describe("WindowRatioTracker", () => {
  it("record + getBudget über die Klassen-API", () => {
    const t = new WindowRatioTracker();
    t.record("codex", { fivePct: 0, weeklyPct: 0 });
    t.record("codex", { fivePct: 100, weeklyPct: 14 });
    t.record("codex", { fivePct: 0, weeklyPct: 14 });
    t.record("codex", { fivePct: 100, weeklyPct: 28 });
    const b = t.getBudget("codex", 28);
    expect(b.learning).toBe(false);
    if (!b.learning) expect(b.windowsPerWeek).toBeCloseTo(200 / 28);
  });

  it("mergeSeed addiert Summen und setzt seededThrough", () => {
    const t = new WindowRatioTracker();
    t.record("claude", { fivePct: 0, weeklyPct: 0 });
    t.record("claude", { fivePct: 50, weeklyPct: 16 });
    const seed = emptyRatioFile();
    seed.providers.claude = { ...emptyProviderState(), sumFivePct: 850, sumWeeklyPct: 284, pairCount: 99 };
    seed.seededThrough = "2026-06-10";
    t.mergeSeed(seed);
    expect(t.getFile().providers.claude.sumFivePct).toBe(900);
    expect(t.getFile().providers.claude.sumWeeklyPct).toBe(300);
    expect(t.getFile().seededThrough).toBe("2026-06-10");
  });
});
