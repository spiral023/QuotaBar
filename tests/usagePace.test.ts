import { describe, expect, it } from "vitest";
import { computeLinearPace, computeSafetyGap, RateWindow } from "../src/usage/usagePace";
import type { UsagePace } from "../src/usage/usagePace";

const SEVEN_DAYS_S = 7 * 24 * 3600;
const NOW = new Date("2026-01-01T00:00:00.000Z");

function makeWindow(
  elapsedFraction: number,
  usedPercent: number,
  windowMinutes = 10080
): RateWindow {
  const duration = windowMinutes * 60;
  const elapsed = duration * elapsedFraction;
  const timeUntilReset = duration - elapsed;
  const resetsAt = new Date(NOW.getTime() + timeUntilReset * 1000);
  return { usedPercent, windowMinutes, resetsAt };
}

describe("computeLinearPace", () => {
  it("onTrack: elapsed=50%, actual=50% → delta≈0, willLastToReset=true", () => {
    const result = computeLinearPace(makeWindow(0.5, 50), NOW);
    expect(result).not.toBeNull();
    expect(result!.stage).toBe("onTrack");
    expect(result!.deltaPercent).toBeCloseTo(0, 1);
    expect(result!.willLastToReset).toBe(true);
    expect(result!.etaSeconds).toBeNull();
  });

  it("farAhead: elapsed=30%, actual=45% → delta=+15, stage=farAhead", () => {
    const result = computeLinearPace(makeWindow(0.3, 45), NOW);
    expect(result).not.toBeNull();
    expect(result!.stage).toBe("farAhead");
    expect(result!.deltaPercent).toBeCloseTo(15, 1);
  });

  it("high burn: elapsed=50%, actual=80% → etaSeconds gesetzt, willLastToReset=false", () => {
    const result = computeLinearPace(makeWindow(0.5, 80), NOW);
    expect(result).not.toBeNull();
    expect(result!.etaSeconds).not.toBeNull();
    expect(result!.willLastToReset).toBe(false);
    // candidate = (20 / (80/302400)) ≈ 75600s ≈ 21h
    expect(result!.etaSeconds!).toBeCloseTo(75600, -2);
  });

  it("null wenn resetsAt=null", () => {
    const w: RateWindow = { usedPercent: 50, windowMinutes: 10080, resetsAt: null };
    expect(computeLinearPace(w, NOW)).toBeNull();
  });

  it("elapsed>0, actual=0 → willLastToReset=true, kein ETA", () => {
    const result = computeLinearPace(makeWindow(0.5, 0), NOW);
    expect(result).not.toBeNull();
    expect(result!.willLastToReset).toBe(true);
    expect(result!.etaSeconds).toBeNull();
  });

  it("elapsed=0, actual>0 → null (ungültiger Zustand)", () => {
    // resetsAt genau duration von jetzt → elapsed=0
    const resetsAt = new Date(NOW.getTime() + SEVEN_DAYS_S * 1000);
    const w: RateWindow = { usedPercent: 10, windowMinutes: 10080, resetsAt };
    expect(computeLinearPace(w, NOW)).toBeNull();
  });

  it("timeUntilReset > duration → null", () => {
    const resetsAt = new Date(NOW.getTime() + (SEVEN_DAYS_S + 1) * 1000);
    const w: RateWindow = { usedPercent: 50, windowMinutes: 10080, resetsAt };
    expect(computeLinearPace(w, NOW)).toBeNull();
  });
});

const GAP_NOW = new Date("2026-01-01T12:00:00.000Z");

function gapResetsAt(offsetSeconds: number): string {
  return new Date(GAP_NOW.getTime() + offsetSeconds * 1000).toISOString();
}

function makePace(overrides: Partial<UsagePace>): UsagePace {
  return {
    stage: "onTrack",
    deltaPercent: 0,
    expectedUsedPercent: 50,
    actualUsedPercent: 50,
    etaSeconds: null,
    willLastToReset: true,
    ...overrides,
  };
}

describe("computeSafetyGap", () => {
  it("willLastToReset=true → returns timeToReset (safe, large positive)", () => {
    const resetsAt = gapResetsAt(3600);
    const pace = makePace({ willLastToReset: true, etaSeconds: null });
    expect(computeSafetyGap(resetsAt, pace, GAP_NOW)).toBeCloseTo(3600, 0);
  });

  it("etaSeconds < timeToReset → positive gap (blocking duration = timeToReset - etaSeconds)", () => {
    const resetsAt = gapResetsAt(3600);
    const pace = makePace({ willLastToReset: false, etaSeconds: 1800 });
    expect(computeSafetyGap(resetsAt, pace, GAP_NOW)).toBeCloseTo(1800, 0);
  });

  it("small etaSeconds → small gap (almost no time until limit)", () => {
    const resetsAt = gapResetsAt(3600);
    const pace = makePace({ willLastToReset: false, etaSeconds: 600 });
    expect(computeSafetyGap(resetsAt, pace, GAP_NOW)).toBeCloseTo(3000, 0);
  });

  it("past reset → null", () => {
    const resetsAt = gapResetsAt(-1);
    const pace = makePace({ willLastToReset: false, etaSeconds: 600 });
    expect(computeSafetyGap(resetsAt, pace, GAP_NOW)).toBeNull();
  });

  it("etaSeconds=null and willLastToReset=false → null (no data)", () => {
    const resetsAt = gapResetsAt(3600);
    const pace = makePace({ willLastToReset: false, etaSeconds: null });
    expect(computeSafetyGap(resetsAt, pace, GAP_NOW)).toBeNull();
  });
});
