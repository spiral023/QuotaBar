import { describe, expect, it } from "vitest";
import { BurnRateTracker } from "../src/usage/burnRateTracker";

function atOffset(baseMs: number, offsetMinutes: number): Date {
  return new Date(baseMs + offsetMinutes * 60_000);
}

describe("BurnRateTracker", () => {
  const BASE = new Date("2026-01-01T12:00:00.000Z").getTime();

  it("returns null with fewer than 3 recorded points", () => {
    const t = new BurnRateTracker();
    t.record("claude", "fiveHour", 10, atOffset(BASE, 0));
    t.record("claude", "fiveHour", 15, atOffset(BASE, 5));
    expect(t.getBurnRate("claude", "fiveHour")).toBeNull();
  });

  it("returns null when time span is less than 2 minutes", () => {
    const t = new BurnRateTracker();
    t.record("claude", "fiveHour", 10, atOffset(BASE, 0));
    t.record("claude", "fiveHour", 11, atOffset(BASE, 0.5));
    t.record("claude", "fiveHour", 12, atOffset(BASE, 1));
    expect(t.getBurnRate("claude", "fiveHour")).toBeNull();
  });

  it("computes correct burn rate in %/h — 6% over 30min = 12%/h", () => {
    const t = new BurnRateTracker();
    t.record("claude", "fiveHour", 0,  atOffset(BASE,  0));
    t.record("claude", "fiveHour", 3,  atOffset(BASE, 15));
    t.record("claude", "fiveHour", 6,  atOffset(BASE, 30));
    expect(t.getBurnRate("claude", "fiveHour")).toBeCloseTo(12, 0);
  });

  it("resets buffer when pct drops by more than 15pp (window cycle boundary)", () => {
    const t = new BurnRateTracker();
    t.record("claude", "fiveHour", 80, atOffset(BASE,  0));
    t.record("claude", "fiveHour", 90, atOffset(BASE, 10));
    // Large drop → new cycle detected, buffer resets to just this point
    t.record("claude", "fiveHour",  5, atOffset(BASE, 20));
    // Only 1 point after reset → null
    expect(t.getBurnRate("claude", "fiveHour")).toBeNull();
  });

  it("accumulates correctly after a reset-detected drop", () => {
    const t = new BurnRateTracker();
    t.record("claude", "fiveHour", 80, atOffset(BASE,  0));
    t.record("claude", "fiveHour", 90, atOffset(BASE, 10));
    t.record("claude", "fiveHour",  5, atOffset(BASE, 20)); // reset detected
    t.record("claude", "fiveHour", 10, atOffset(BASE, 30));
    t.record("claude", "fiveHour", 15, atOffset(BASE, 40));
    // 3 points: 5@20min, 10@30min, 15@40min → 10% over 20min = 30%/h
    expect(t.getBurnRate("claude", "fiveHour")).toBeCloseTo(30, 0);
  });

  it("provider and windowName are tracked independently", () => {
    const t = new BurnRateTracker();
    t.record("claude", "fiveHour", 0,  atOffset(BASE,  0));
    t.record("claude", "fiveHour", 6,  atOffset(BASE, 30));
    t.record("claude", "fiveHour", 12, atOffset(BASE, 60));
    expect(t.getBurnRate("claude", "weekly")).toBeNull();
    expect(t.getBurnRate("codex", "fiveHour")).toBeNull();
  });

  it("keeps at most 8 points per key (ring buffer)", () => {
    const t = new BurnRateTracker();
    for (let i = 0; i <= 10; i++) {
      t.record("claude", "fiveHour", i, atOffset(BASE, i * 5));
    }
    // Should still return a valid rate using the most recent 5 of 8 points
    const rate = t.getBurnRate("claude", "fiveHour");
    expect(rate).not.toBeNull();
    // Last 5 points: i=6..10, pct=6..10, over 20min → 4%/20min = 12%/h
    expect(rate).toBeCloseTo(12, 0);
  });
});
