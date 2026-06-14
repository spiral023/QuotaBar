import { describe, expect, it } from "vitest";
import { buildCurrentWindowUsage, type CurrentWindowObservation } from "../src/usage/windowBudgetRollup";

function obs(
  ts: string,
  fivePct: number,
  fiveResetsAt: string | null,
  weeklyPct: number,
  weeklyResetsAt: string | null,
): CurrentWindowObservation {
  return { ts, fivePct, fiveResetsAt, weeklyPct, weeklyResetsAt };
}

describe("buildCurrentWindowUsage", () => {
  const windowsPerWeek = 8.338;
  const weeklyReset = "2026-06-16T11:00:00Z";

  it("uses the current weekly percentage when no bonus reset happened", () => {
    const usage = buildCurrentWindowUsage([
      obs("2026-06-10T10:00:00Z", 10, "2026-06-10T15:00:00Z", 10, weeklyReset),
      obs("2026-06-10T12:00:00Z", 80, "2026-06-10T15:00:00Z", 40, weeklyReset),
      obs("2026-06-10T15:10:00Z", 2, "2026-06-10T20:10:00Z", 40, weeklyReset),
      obs("2026-06-10T18:00:00Z", 50, "2026-06-10T20:10:00Z", 62, weeklyReset),
    ], windowsPerWeek, 62);

    expect(usage.observedUsedWindows).toBe(2);
    expect(usage.bonusResetCount).toBe(0);
    expect(usage.resetAdjustedWeeklyPercent).toBe(62);
    expect(usage.budgetEquivalentUsedWindows).toBeCloseTo(5.16956, 5);
    expect(usage.remainingWindows).toBeCloseTo(3.16844, 5);
  });

  it("adds the pre-reset weekly peak when weekly drops without a regular reset advance", () => {
    const usage = buildCurrentWindowUsage([
      obs("2026-06-12T09:30:00Z", 37, "2026-06-12T13:30:00Z", 67, weeklyReset),
      obs("2026-06-13T08:04:00Z", 0, null, 0, null),
      obs("2026-06-13T09:30:00Z", 17, "2026-06-13T13:30:00Z", 3, weeklyReset),
      obs("2026-06-14T23:12:00Z", 98, "2026-06-15T01:20:00Z", 74, weeklyReset),
    ], windowsPerWeek, 74);

    expect(usage.observedUsedWindows).toBe(2);
    expect(usage.bonusResetCount).toBe(1);
    expect(usage.preResetWeeklyPercent).toBe(67);
    expect(usage.resetAdjustedWeeklyPercent).toBe(141);
    expect(usage.preResetUsedWindows).toBeCloseTo(5.58646, 5);
    expect(usage.budgetEquivalentUsedWindows).toBeCloseTo(11.75658, 5);
    expect(usage.remainingWindows).toBeCloseTo(2.16788, 5);
    expect(usage.totalWindows).toBeCloseTo(13.92446, 5);
  });

  it("ignores transient weekly 100 spikes before detecting bonus resets", () => {
    const usage = buildCurrentWindowUsage([
      obs("2026-06-13T08:50:00Z", 2, "2026-06-13T13:30:00Z", 0, weeklyReset),
      obs("2026-06-13T09:02:00Z", 5, "2026-06-13T13:30:00Z", 100, weeklyReset),
      obs("2026-06-13T09:04:00Z", 5, "2026-06-13T13:30:00Z", 100, weeklyReset),
      obs("2026-06-13T09:19:00Z", 11, "2026-06-13T13:30:00Z", 2, weeklyReset),
      obs("2026-06-13T09:29:00Z", 17, "2026-06-13T13:30:00Z", 3, weeklyReset),
    ], windowsPerWeek, 3);

    expect(usage.bonusResetCount).toBe(0);
    expect(usage.preResetWeeklyPercent).toBe(0);
    expect(usage.resetAdjustedWeeklyPercent).toBe(3);
  });

  it("does not treat a normal weekly reset advance as bonus budget", () => {
    const nextWeeklyReset = "2026-06-23T11:00:00Z";
    const usage = buildCurrentWindowUsage([
      obs("2026-06-16T10:55:00Z", 90, "2026-06-16T11:00:00Z", 98, weeklyReset),
      obs("2026-06-16T11:05:00Z", 0, "2026-06-16T16:05:00Z", 1, nextWeeklyReset),
      obs("2026-06-16T12:00:00Z", 10, "2026-06-16T16:05:00Z", 2, nextWeeklyReset),
    ], windowsPerWeek, 2);

    expect(usage.bonusResetCount).toBe(0);
    expect(usage.preResetWeeklyPercent).toBe(0);
    expect(usage.resetAdjustedWeeklyPercent).toBe(2);
  });
});
