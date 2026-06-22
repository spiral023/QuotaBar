import { describe, expect, it } from "vitest";
import {
  BonusResetTracker,
  estimateBonusWindows,
  isBonusReset,
  isTransientWeeklySpike,
} from "../src/usage/bonusReset";

const DAY = 24 * 60 * 60 * 1000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

describe("isBonusReset", () => {
  const base = Date.parse("2026-06-10T00:00:00Z");

  it("erkennt einen außerplanmäßigen Reset (Weekly fällt, resetsAt bleibt)", () => {
    const prev = { usedPercent: 46, resetsAt: iso(base + 7 * DAY) };
    const next = { usedPercent: 1, resetsAt: iso(base + 7 * DAY) };
    expect(isBonusReset(prev, next)).toBe(true);
  });

  it("erkennt KEINEN Bonus bei regulärem Reset (resetsAt springt +7d)", () => {
    const prev = { usedPercent: 96, resetsAt: iso(base + 1 * DAY) };
    const next = { usedPercent: 1, resetsAt: iso(base + 8 * DAY) };
    expect(isBonusReset(prev, next)).toBe(false);
  });

  it("kein Bonus, wenn Weekly nicht nennenswert gefallen ist", () => {
    const prev = { usedPercent: 50, resetsAt: iso(base + 7 * DAY) };
    const next = { usedPercent: 55, resetsAt: iso(base + 7 * DAY) };
    expect(isBonusReset(prev, next)).toBe(false);
  });

  it("kein Bonus bei winzigem Abfall (Rundungsrauschen nahe 0)", () => {
    // 3 → 0 ist kein Reset, sondern Ganzzahl-Jitter: zu kleiner Abfall.
    const prev = { usedPercent: 3, resetsAt: iso(base + 7 * DAY) };
    const next = { usedPercent: 0, resetsAt: iso(base + 7 * DAY) };
    expect(isBonusReset(prev, next)).toBe(false);
  });

  it("erkennt einen außerplanmäßigen Reset auch bei niedrigem Vorstand", () => {
    // Stand-unabhängig: ein Kulanz-Reset kann bei 12 % genauso passieren wie bei 80 %.
    const prev = { usedPercent: 12, resetsAt: iso(base + 7 * DAY) };
    const next = { usedPercent: 0, resetsAt: iso(base + 7 * DAY) };
    expect(isBonusReset(prev, next)).toBe(true);
  });

  it("kein Bonus ohne bekannten prev-resetsAt (fehlender Bezugstermin)", () => {
    expect(isBonusReset({ usedPercent: 50, resetsAt: null }, { usedPercent: 1, resetsAt: null })).toBe(false);
  });

  it("erkennt einen Bonus, wenn resetsAt bei 0 % weggelassen wird (Drop VOR dem Termin)", () => {
    // Realfall 2026-06-20: Verbrauch fiel mitten in der Periode auf 0; Claude
    // lieferte dabei kein resetsAt. Der Drop liegt deutlich VOR dem geplanten
    // Termin (23.06.) → außerplanmäßiger Reset.
    const prev = { usedPercent: 61, resetsAt: "2026-06-23T11:00:00Z", ts: "2026-06-19T20:00:00Z" };
    const next = { usedPercent: 0, resetsAt: null, ts: "2026-06-20T06:51:00Z" };
    expect(isBonusReset(prev, next)).toBe(true);
  });

  it("kein Bonus, wenn der Drop AM Termin liegt und resetsAt fehlt (regulärer Reset)", () => {
    // Regulärer Reset an der Periodengrenze; resetsAt bei 0 % weggelassen.
    const prev = { usedPercent: 98, resetsAt: "2026-06-16T11:00:00Z", ts: "2026-06-16T10:00:00Z" };
    const next = { usedPercent: 0, resetsAt: null, ts: "2026-06-16T16:30:00Z" };
    expect(isBonusReset(prev, next)).toBe(false);
  });

  it("kein Bonus bei selbst eingelöstem Reset (resetsAt springt < 7d, aber > 0 nach vorn)", () => {
    // Realfall 2026-06-21: Codex-Selbst-Reset. Weekly 100 → 0, resetsAt springt
    // um ~3,7 Tage nach vorn (25.06. → 28.06.) — die Restzeit des alten Fensters,
    // nicht volle 7 Tage. Das ist ein NEUES 7d-Fenster, kein Kulanz-Bonus.
    const prev = { usedPercent: 100, resetsAt: "2026-06-25T00:53:07Z", ts: "2026-06-21T16:12:00Z" };
    const next = { usedPercent: 0, resetsAt: "2026-06-28T17:45:32Z", ts: "2026-06-21T17:46:00Z" };
    expect(isBonusReset(prev, next)).toBe(false);
  });
});

describe("isTransientWeeklySpike", () => {
  const reset = iso(Date.parse("2026-06-23T11:00:00Z"));

  it("erkennt den Aufwärts-Spike (Weekly springt auf ~100, während 5h niedrig bleibt)", () => {
    // Echtes Artefakt aus den Logs: weekly 0 → 100 in einem Poll, 5h nur 4 → 6.
    const prev = { usedPercent: 0, resetsAt: reset, fivePercent: 4 };
    const next = { usedPercent: 100, resetsAt: reset, fivePercent: 6 };
    expect(isTransientWeeklySpike(prev, next)).toBe(true);
  });

  it("kein Spike bei echtem allmählichem Anstieg auf 100", () => {
    const prev = { usedPercent: 96, resetsAt: reset, fivePercent: 80 };
    const next = { usedPercent: 100, resetsAt: reset, fivePercent: 90 };
    expect(isTransientWeeklySpike(prev, next)).toBe(false);
  });

  it("kein Spike, wenn der Sprung von paralleler 5h-Bewegung gedeckt ist", () => {
    // dWeekly <= dFive verletzt die Invariante nicht → kein Artefakt.
    const prev = { usedPercent: 0, resetsAt: reset, fivePercent: 0 };
    const next = { usedPercent: 100, resetsAt: reset, fivePercent: 100 };
    expect(isTransientWeeklySpike(prev, next)).toBe(false);
  });
});

describe("estimateBonusWindows", () => {
  const now = Date.parse("2026-06-12T00:00:00Z");

  it("wird durch die verbleibende Zeit begrenzt", () => {
    // 10 h bis Reset → höchstens 2 weitere 5h-Fenster, Budget großzügig.
    const resets = iso(now + 10 * 60 * 60 * 1000);
    expect(estimateBonusWindows(resets, now, 8)).toBeCloseTo(2, 5);
  });

  it("wird auf das Budget (windowsPerWeek) gedeckelt", () => {
    // 7 Tage bis Reset → zeitlich ~33 Fenster, aber Budget = 4.
    const resets = iso(now + 7 * DAY);
    expect(estimateBonusWindows(resets, now, 4)).toBe(4);
  });

  it("liefert 0, wenn der Reset bereits vergangen ist", () => {
    expect(estimateBonusWindows(iso(now - DAY), now, 8)).toBe(0);
  });

  it("liefert 0 ohne resetsAt", () => {
    expect(estimateBonusWindows(null, now, 8)).toBe(0);
  });
});

describe("BonusResetTracker", () => {
  const base = Date.parse("2026-06-10T00:00:00Z");
  const reset = iso(base + 7 * DAY);

  it("setzt den Bonus-Marker und liefert ihn für die laufende Periode", () => {
    const t = new BonusResetTracker();
    t.record("claude", "max", { usedPercent: 46, resetsAt: reset });
    t.record("claude", "max", { usedPercent: 1, resetsAt: reset }); // außerplanmäßig
    const bonus = t.getBonus("claude", "max", reset, base + 5 * DAY, 8);
    expect(bonus?.active).toBe(true);
    expect(bonus!.estimatedExtraWindows).toBeGreaterThan(0);
  });

  it("liefert keinen Bonus im normalen Verlauf", () => {
    const t = new BonusResetTracker();
    t.record("claude", "max", { usedPercent: 30, resetsAt: reset });
    t.record("claude", "max", { usedPercent: 40, resetsAt: reset });
    expect(t.getBonus("claude", "max", reset, base + 5 * DAY, 8)).toBeNull();
  });

  it("verwirft den Marker, wenn die Periode regulär weiterspringt", () => {
    const t = new BonusResetTracker();
    t.record("claude", "max", { usedPercent: 46, resetsAt: reset });
    t.record("claude", "max", { usedPercent: 1, resetsAt: reset }); // Bonus aktiv
    const nextReset = iso(base + 14 * DAY);
    t.record("claude", "max", { usedPercent: 2, resetsAt: nextReset }); // regulärer Rollover
    expect(t.getBonus("claude", "max", nextReset, base + 8 * DAY, 8)).toBeNull();
  });

  it("trennt nach Anbieter/Tier", () => {
    const t = new BonusResetTracker();
    t.record("claude", "max", { usedPercent: 46, resetsAt: reset });
    t.record("claude", "max", { usedPercent: 1, resetsAt: reset });
    expect(t.getBonus("codex", "team", reset, base + 5 * DAY, 8)).toBeNull();
  });

  it("setzt KEINEN Bonus bei selbst eingelöstem Codex-Reset (resetsAt verschoben)", () => {
    // Selbst eingelöster 7d-Reset: Weekly 100 → 0 UND resetsAt rückt nach vorn
    // (25.06. → 28.06.). Neues Fenster, kein Bonus-Budget oben drauf.
    const t = new BonusResetTracker();
    t.record("codex", "team", { usedPercent: 100, resetsAt: "2026-06-25T00:53:07Z", fivePercent: 100, ts: "2026-06-21T16:12:00Z" });
    t.record("codex", "team", { usedPercent: 0, resetsAt: "2026-06-28T17:45:32Z", fivePercent: 0, ts: "2026-06-21T17:46:00Z" });
    const nowMs = Date.parse("2026-06-22T00:00:00Z");
    expect(t.getBonus("codex", "team", "2026-06-28T17:45:32Z", nowMs, 8)).toBeNull();
  });

  it("löst KEINEN Bonus durch einen transienten Weekly-Spike aus (Skalen-Artefakt)", () => {
    // Reale Sequenz aus 2026-06-16: direkt nach dem regulären Reset blähte die
    // alte utilization-Heuristik 1 % → 100 % auf; das 5h-Fenster lief monoton
    // weiter. Der Spike-Filter muss den 100-%-Ausreißer verwerfen, sonst sieht
    // der Übergang 100 → 2 wie ein außerplanmäßiger Reset aus.
    const t = new BonusResetTracker();
    t.record("claude", "max", { usedPercent: 0, resetsAt: reset, fivePercent: 4 });
    t.record("claude", "max", { usedPercent: 100, resetsAt: reset, fivePercent: 6 });
    t.record("claude", "max", { usedPercent: 100, resetsAt: reset, fivePercent: 8 });
    t.record("claude", "max", { usedPercent: 2, resetsAt: reset, fivePercent: 12 });
    expect(t.getBonus("claude", "max", reset, base + 5 * DAY, 8)).toBeNull();
  });
});
