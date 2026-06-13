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
  it("voller aktiver Tag = amount/30 (USD)", () => {
    expect(dailySubCostUSD([plan({})], "claude", "2026-03-10", fx)).toBeCloseTo(1.0, 6);
  });
  it("Lücke = 0", () => {
    expect(dailySubCostUSD([plan({ startsAt: "2026-04-01T00:00:00.000Z" })], "claude", "2026-03-10", fx)).toBe(0);
  });
  it("Overlap summiert beide Pläne", () => {
    const v = dailySubCostUSD([plan({ id: "a" }), plan({ id: "b", amount: 60 })], "claude", "2026-03-10", fx);
    expect(v).toBeCloseTo(1.0 + 2.0, 6);
  });
  it("€ wird mit Tageskurs umgerechnet", () => {
    const v = dailySubCostUSD([plan({ currency: "EUR", amount: 30 })], "claude", "2026-03-10", fx);
    expect(v).toBeCloseTo(1.0 * 1.10, 6);
  });
  it("Grenztag wird anteilig nach Uhrzeit prorat", () => {
    const v = dailySubCostUSD([plan({ startsAt: "2026-03-10T12:00:00.000Z" })], "claude", "2026-03-10", fx);
    expect(v).toBeGreaterThan(0.4); expect(v).toBeLessThan(0.6);
  });
  it("ignoriert anderen Anbieter", () => {
    expect(dailySubCostUSD([plan({ provider: "codex" })], "claude", "2026-03-10", fx)).toBe(0);
  });
});

describe("periodSubCostUSD", () => {
  it("summiert Tageskosten über den Bereich", () => {
    const v = periodSubCostUSD([plan({})], "claude", "2026-03-10", "2026-03-12", fx);
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
