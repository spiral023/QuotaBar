import { describe, expect, it } from "vitest";
import {
  computeBudget,
  clearTransients,
  emptyProviderState,
  emptyRatioFile,
  recordObservation,
  ratioKey,
  resetsAtChanged,
  WindowRatioTracker,
  MAX_PAIR_AGE_MS,
  MIN_SAMPLE_FIVE_PCT,
  DECAY_CAP_FIVE_PCT,
  type ProviderRatioState,
} from "../src/usage/windowRatio";

function feed(state: ProviderRatioState, pairs: Array<[number, number]>, resetsAt = "2026-06-08T10:00:00Z"): ProviderRatioState {
  let s = state;
  let t = Date.parse("2026-06-08T10:00:00Z");
  for (const [five, weekly] of pairs) {
    s = recordObservation(s, { fivePct: five, weeklyPct: weekly, fiveResetsAt: resetsAt, ts: new Date(t).toISOString() });
    t += 60_000;
  }
  return s;
}

describe("resetsAtChanged", () => {
  it("gibt false zurück bei Mikrosekunden-Jitter (Claude-API-Eigenheit)", () => {
    expect(resetsAtChanged(
      "2026-05-26T12:20:00.739597+00:00",
      "2026-05-26T12:20:00.750574+00:00",
    )).toBe(false);
  });

  it("gibt true zurück bei 5-Stunden-Differenz (echter Rollover)", () => {
    expect(resetsAtChanged(
      "2026-06-08T10:00:00Z",
      "2026-06-08T15:00:00Z",
    )).toBe(true);
  });

  it("gibt false zurück bei genau 60 s Differenz (Randwert ≤ Toleranz)", () => {
    expect(resetsAtChanged(
      "2026-06-08T10:00:00.000Z",
      "2026-06-08T10:01:00.000Z",
    )).toBe(false);
  });

  it("gibt true zurück bei 61 s Differenz (knapp über Toleranz)", () => {
    expect(resetsAtChanged(
      "2026-06-08T10:00:00.000Z",
      "2026-06-08T10:01:01.000Z",
    )).toBe(true);
  });

  it("gibt false zurück wenn eine Seite null ist", () => {
    expect(resetsAtChanged(null, "2026-06-08T10:00:00Z")).toBe(false);
    expect(resetsAtChanged("2026-06-08T10:00:00Z", null)).toBe(false);
    expect(resetsAtChanged(null, null)).toBe(false);
    expect(resetsAtChanged(undefined, "2026-06-08T10:00:00Z")).toBe(false);
  });

  it("gibt true zurück bei zwei unterschiedlichen unparsebaren Strings (Fallback)", () => {
    expect(resetsAtChanged("not-a-date", "also-not-a-date")).toBe(true);
  });
});

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
    // 5-hour difference → genuine rollover, pair must be discarded
    let s = recordObservation(emptyProviderState(), { fivePct: 80, weeklyPct: 50, fiveResetsAt: "2026-06-08T10:00:00Z", ts: "2026-06-08T10:00:00Z" });
    s = recordObservation(s, { fivePct: 90, weeklyPct: 55, fiveResetsAt: "2026-06-08T15:00:00Z", ts: "2026-06-08T10:01:00Z" });
    expect(s.sumFivePct).toBe(0);
    expect(s.lastFiveResetsAt).toBe("2026-06-08T15:00:00Z");
  });

  it("akzeptiert Paare wenn fiveResetsAt nur Mikrosekunden-Jitter zeigt (kein Rollover)", () => {
    // Same reset instant re-serialized with microsecond jitter — must NOT be treated as rollover
    let s = recordObservation(emptyProviderState(), {
      fivePct: 10,
      weeklyPct: 3,
      fiveResetsAt: "2026-05-26T12:20:00.739597+00:00",
      ts: "2026-05-26T12:20:00Z",
    });
    s = recordObservation(s, {
      fivePct: 20,
      weeklyPct: 6,
      fiveResetsAt: "2026-05-26T12:20:00.750574+00:00",
      ts: "2026-05-26T12:21:00Z",
    });
    expect(s.sumFivePct).toBe(10);
    expect(s.sumWeeklyPct).toBe(3);
    expect(s.pairCount).toBe(1);
  });

  it("akzeptiert Paare ohne resetsAt (Claude liefert es teils nicht)", () => {
    let s = recordObservation(emptyProviderState(), { fivePct: 10, weeklyPct: 5, ts: "2026-06-08T10:00:00Z" });
    s = recordObservation(s, { fivePct: 20, weeklyPct: 8, ts: "2026-06-08T10:01:00Z" });
    expect(s.sumFivePct).toBe(10);
    expect(s.sumWeeklyPct).toBe(3);
  });

  it("verwirft Paare bei gesättigtem Weekly (≥ 99,5 %)", () => {
    const s = feed(emptyProviderState(), [[10, 100], [30, 100]]);
    expect(s.sumFivePct).toBe(0);
  });

  it("setzt den State bei planType-Wechsel zurück", () => {
    let s = recordObservation(emptyProviderState(), { fivePct: 0, weeklyPct: 0, planType: "pro", ts: "2026-06-08T10:00:00Z" });
    s = recordObservation(s, { fivePct: 50, weeklyPct: 20, planType: "pro", ts: "2026-06-08T10:01:00Z" });
    expect(s.sumFivePct).toBe(50);
    s = recordObservation(s, { fivePct: 60, weeklyPct: 22, planType: "max", ts: "2026-06-08T10:02:00Z" });
    expect(s.sumFivePct).toBe(0);
    expect(s.lastPlanType).toBe("max");
  });

  it("halbiert beide Summen oberhalb des Decay-Deckels", () => {
    let s = emptyProviderState();
    // lastTs is set 60s before the observation so the gap guard passes
    s = { ...s, sumFivePct: DECAY_CAP_FIVE_PCT - 10, sumWeeklyPct: 900, lastFive: 0, lastWeekly: 0, lastTs: "2026-06-08T09:59:00Z" };
    s = recordObservation(s, { fivePct: 50, weeklyPct: 15, ts: "2026-06-08T10:00:00Z" });
    expect(s.sumFivePct).toBeCloseTo((DECAY_CAP_FIVE_PCT - 10 + 50) / 2);
    expect(s.sumWeeklyPct).toBeCloseTo(915 / 2);
  });

  it("verwirft Paare mit Lücke > 10 Minuten (max-age guard)", () => {
    const t0 = "2026-06-08T10:00:00Z";
    const t1 = "2026-06-08T10:11:00Z"; // 11 minutes later — exceeds MAX_PAIR_AGE_MS
    let s = recordObservation(emptyProviderState(), { fivePct: 10, weeklyPct: 5, ts: t0 });
    const sumBefore = s.sumFivePct;
    s = recordObservation(s, { fivePct: 20, weeklyPct: 8, ts: t1 });
    expect(s.sumFivePct).toBe(sumBefore); // pair discarded
    expect(s.pairCount).toBe(0);
    expect(s.lastFive).toBe(20); // lastFive updated regardless
    expect(s.lastTs).toBe(t1);   // lastTs updated regardless
  });

  it("akzeptiert Paare mit Lücke genau ≤ 10 Minuten", () => {
    const t0 = "2026-06-08T10:00:00Z";
    const t1 = new Date(Date.parse(t0) + MAX_PAIR_AGE_MS).toISOString(); // exactly 10 min
    let s = recordObservation(emptyProviderState(), { fivePct: 10, weeklyPct: 5, ts: t0 });
    s = recordObservation(s, { fivePct: 20, weeklyPct: 8, ts: t1 });
    expect(s.sumFivePct).toBe(10);
    expect(s.pairCount).toBe(1);
  });

  it("verwirft Paare, bei denen ΔWeekly > Δ5h (transiente API-Ausreißer, z. B. Weekly-Spike nach Reset)", () => {
    // [0,0] → [6,100]: dFive=6, dWeekly=100 → physikalisch unmöglich → rejected
    // sums stay 0, pairCount 0, but lastFive/lastWeekly are updated
    let s = recordObservation(emptyProviderState(), { fivePct: 0, weeklyPct: 0, ts: "2026-06-08T10:00:00Z" });
    s = recordObservation(s, { fivePct: 6, weeklyPct: 100, ts: "2026-06-08T10:01:00Z" });
    expect(s.sumFivePct).toBe(0);
    expect(s.sumWeeklyPct).toBe(0);
    expect(s.pairCount).toBe(0);
    expect(s.lastFive).toBe(6);
    expect(s.lastWeekly).toBe(100);
  });

  it("akzeptiert Paare mit ΔWeekly = Δ5h (Gleichheit, durch Rundung möglich)", () => {
    // [0,0] → [1,1]: dFive=1, dWeekly=1 → valid (equality allowed)
    let s = recordObservation(emptyProviderState(), { fivePct: 0, weeklyPct: 0, ts: "2026-06-08T10:00:00Z" });
    s = recordObservation(s, { fivePct: 1, weeklyPct: 1, ts: "2026-06-08T10:01:00Z" });
    expect(s.sumFivePct).toBe(1);
    expect(s.sumWeeklyPct).toBe(1);
    expect(s.pairCount).toBe(1);
  });

  it("vollständiger Spike-Zyklus heilt sich selbst: nur gültige Paare fließen ein", () => {
    // [0,0] → [6,100]: dW=100>dF=6 → rejected (spike up)
    // [6,100] → [8,14]: dW=-86<0 → rejected (weekly reset filter)
    // [8,14] → [10,15]: dF=2, dW=1 → accepted
    // final sums: sumFive=2, sumWeekly=1
    let s = recordObservation(emptyProviderState(), { fivePct: 0, weeklyPct: 0, ts: "2026-06-08T10:00:00Z" });
    s = recordObservation(s, { fivePct: 6, weeklyPct: 100, ts: "2026-06-08T10:01:00Z" });
    expect(s.sumFivePct).toBe(0); // spike rejected
    s = recordObservation(s, { fivePct: 8, weeklyPct: 14, ts: "2026-06-08T10:02:00Z" });
    expect(s.sumFivePct).toBe(0); // weekly reset rejected
    s = recordObservation(s, { fivePct: 10, weeklyPct: 15, ts: "2026-06-08T10:03:00Z" });
    expect(s.sumFivePct).toBe(2);
    expect(s.sumWeeklyPct).toBe(1);
    expect(s.pairCount).toBe(1);
  });

  it("verwirft das erste Paar nach clearTransients (lastTs null → kein Paar)", () => {
    // Build up some state then clear transients
    let s = feed(emptyProviderState(), [[0, 0], [10, 3]]);
    expect(s.pairCount).toBe(1);
    const file = emptyRatioFile();
    file.providers["p"] = s;
    const cleared = clearTransients(file);
    // First observation after clear: lastTs is null → no pair formed
    const s2 = recordObservation(cleared.providers["p"]!, { fivePct: 20, weeklyPct: 6, ts: "2026-06-08T11:00:00Z" });
    expect(s2.pairCount).toBe(1); // still 1 — no new pair
    expect(s2.lastTs).toBe("2026-06-08T11:00:00Z");
  });
});

describe("ratioKey", () => {
  it("erzeugt korrekte Keys für verschiedene planType-Werte", () => {
    expect(ratioKey("claude", "default_raven")).toBe("claude:default_raven");
    expect(ratioKey("claude", null)).toBe("claude:default");
    expect(ratioKey("claude", undefined)).toBe("claude:default");
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

describe("emptyRatioFile", () => {
  it("hat version 4", () => {
    expect(emptyRatioFile().version).toBe(4);
  });
});

describe("clearTransients", () => {
  it("löscht last-Werte inklusive lastTs, behält Summen und planType", () => {
    const file = emptyRatioFile();
    file.providers.claude = {
      ...emptyProviderState(),
      sumFivePct: 500,
      sumWeeklyPct: 160,
      lastFive: 80,
      lastWeekly: 30,
      lastFiveResetsAt: "x",
      lastPlanType: "pro",
      lastTs: "2026-06-08T10:00:00Z",
    };
    const out = clearTransients(file);
    expect(out.providers.claude.lastFive).toBeNull();
    expect(out.providers.claude.lastWeekly).toBeNull();
    expect(out.providers.claude.lastFiveResetsAt).toBeNull();
    expect(out.providers.claude.lastTs).toBeNull();
    expect(out.providers.claude.sumFivePct).toBe(500);
    expect(out.providers.claude.lastPlanType).toBe("pro");
  });
});

describe("WindowRatioTracker", () => {
  it("record + getBudget über die Klassen-API (tier-keyed)", () => {
    const t = new WindowRatioTracker();
    // No planType → key is "codex:default"
    t.record("codex", { fivePct: 0, weeklyPct: 0, ts: "2026-06-08T10:00:00Z" });
    t.record("codex", { fivePct: 100, weeklyPct: 14, ts: "2026-06-08T10:01:00Z" });
    t.record("codex", { fivePct: 0, weeklyPct: 14, ts: "2026-06-08T10:02:00Z" });
    t.record("codex", { fivePct: 100, weeklyPct: 28, ts: "2026-06-08T10:03:00Z" });
    const b = t.getBudget("codex", null, 28);
    expect(b.learning).toBe(false);
    if (!b.learning) expect(b.windowsPerWeek).toBeCloseTo(200 / 28);
  });

  it("mergeSeed addiert Summen und setzt seededThrough", () => {
    const t = new WindowRatioTracker();
    // No planType → records under "claude:default"
    t.record("claude", { fivePct: 0, weeklyPct: 0, ts: "2026-06-08T10:00:00Z" });
    t.record("claude", { fivePct: 50, weeklyPct: 16, ts: "2026-06-08T10:01:00Z" });
    const seed = emptyRatioFile();
    // Seed key must match tracker's tier key to merge correctly
    seed.providers["claude:default"] = { ...emptyProviderState(), sumFivePct: 850, sumWeeklyPct: 284, pairCount: 99 };
    seed.seededThrough = "2026-06-10";
    t.mergeSeed(seed);
    expect(t.getFile().providers["claude:default"].sumFivePct).toBe(900);
    expect(t.getFile().providers["claude:default"].sumWeeklyPct).toBe(300);
    expect(t.getFile().seededThrough).toBe("2026-06-10");
  });

  it("Tier-Keying: verschiedene planTypes landen in separaten States", () => {
    const t = new WindowRatioTracker();
    const t0 = "2026-06-08T10:00:00Z";
    const t1 = "2026-06-08T10:01:00Z";
    const t2 = "2026-06-08T10:02:00Z";

    // Build up tierA state
    t.record("claude", { fivePct: 0, weeklyPct: 0, planType: "tierA", ts: t0 });
    t.record("claude", { fivePct: 50, weeklyPct: 10, planType: "tierA", ts: t1 });
    const sumAfterTierA = t.getFile().providers["claude:tierA"]!.sumFivePct;
    expect(sumAfterTierA).toBe(50);

    // Record a tierB observation — must NOT reset tierA's sums
    t.record("claude", { fivePct: 10, weeklyPct: 2, planType: "tierB", ts: t2 });
    expect(t.getFile().providers["claude:tierA"]!.sumFivePct).toBe(50); // untouched

    // Switch back to tierA: gap ≤ 10 min so pair IS accepted
    // (resetsAt-rollover / max-age guard the cross-account cases in the wild)
    const t3 = "2026-06-08T10:03:00Z";
    t.record("claude", { fivePct: 70, weeklyPct: 15, planType: "tierA", ts: t3 });
    // Gap from t1 to t3 is 2 minutes — within max-age, pair accepted
    expect(t.getFile().providers["claude:tierA"]!.sumFivePct).toBeGreaterThan(50);
  });
});
