import { describe, it, expect } from "vitest";
import type { PlanPeriod } from "../src/config/settings";
import { makeFxLookup } from "../src/pricing/fx-fetcher";
import { dailySubCostUSD, periodSubCostUSD, planChangePoints } from "../src/pricing/plan-cost";

const fx = makeFxLookup({ "2026-03-10": 1.10 }, false);
const plan = (o: Partial<PlanPeriod>): PlanPeriod => ({
  id: "x", provider: "claude", name: "Pro", amount: 30, currency: "USD",
  startsAt: "2026-03-01T00:00:00.000Z", endsAt: null, ...o,
});

describe("dailySubCostUSD", () => {
  it("full active day is prorated by the actual calendar month length", () => {
    expect(dailySubCostUSD([plan({ amount: 31 })], "claude", "2026-03-10", fx)).toBeCloseTo(1.0, 6);
    expect(dailySubCostUSD([plan({ amount: 28, startsAt: "2026-02-01T00:00:00.000Z" })], "claude", "2026-02-10", fx)).toBeCloseTo(1.0, 6);
  });
  it("Lücke = 0", () => {
    expect(dailySubCostUSD([plan({ startsAt: "2026-04-01T00:00:00.000Z" })], "claude", "2026-03-10", fx)).toBe(0);
  });
  it("Overlap summiert beide Pläne", () => {
    const v = dailySubCostUSD([plan({ id: "a" }), plan({ id: "b", amount: 60 })], "claude", "2026-03-10", fx);
    expect(v).toBeCloseTo(30 / 31 + 60 / 31, 6);
  });
  it("€ wird mit Tageskurs umgerechnet", () => {
    const v = dailySubCostUSD([plan({ currency: "EUR", amount: 30 })], "claude", "2026-03-10", fx);
    expect(v).toBeCloseTo((30 / 31) * 1.10, 6);
  });
  it("Grenztag wird anteilig nach Uhrzeit prorat", () => {
    // Start auf LOKALE Mittagszeit → exakt halber lokaler Tag aktiv, in jeder Zeitzone.
    const localNoon = new Date(2026, 2, 10, 12, 0, 0).toISOString();
    const v = dailySubCostUSD([plan({ startsAt: localNoon })], "claude", "2026-03-10", fx);
    expect(v).toBeCloseTo((30 / 31) * 0.5, 6);
  });
  it("ignoriert anderen Anbieter", () => {
    expect(dailySubCostUSD([plan({ provider: "codex" })], "claude", "2026-03-10", fx)).toBe(0);
  });
});

describe("periodSubCostUSD", () => {
  it("summiert Tageskosten über den Bereich", () => {
    const v = periodSubCostUSD([plan({ amount: 31 })], "claude", "2026-03-10", "2026-03-12", fx);
    expect(v).toBeCloseTo(3.0, 6);
  });
});

describe("planChangePoints", () => {
  it("liefert Start- und Endpunkte im Bereich", () => {
    const pts = planChangePoints(
      [plan({ name: "Pro", startsAt: "2026-03-05T00:00:00.000Z", endsAt: "2026-03-20T00:00:00.000Z" })],
      "claude", "2026-03-01", "2026-03-31");
    expect(pts.map(p => p.day)).toEqual(["2026-03-05", "2026-03-20"]);
  });
});
