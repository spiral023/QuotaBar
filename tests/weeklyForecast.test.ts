import { describe, expect, it } from "vitest";
import { buildWeeklyProfile, computeWeeklyForecast, type WeeklyProfile } from "../src/main/weeklyForecast";
import type { BackfillDayRecord } from "../src/reports/types";

function day(date: string, provider: "claude" | "codex", totalTokens: number): BackfillDayRecord {
  return {
    date, provider, totalTokens,
    inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
    costUSD: 0, sessionCount: 1, models: [], perModel: {},
  };
}

// 2026-06-11 ist ein Donnerstag
const NOW = new Date("2026-06-11T12:00:00.000Z");

describe("buildWeeklyProfile", () => {
  it("mittelt Token pro Wochentag über 28 Tage", () => {
    const records = [
      day("2026-06-08", "claude", 4_000_000), // Montag
      day("2026-06-01", "claude", 2_000_000), // Montag (Vorwoche)
      day("2026-06-09", "claude", 1_000_000), // Dienstag
      day("2026-06-10", "codex", 9_000_000),  // anderer Provider — ignorieren
      day("2026-04-01", "claude", 9_000_000), // älter als 28 Tage — ignorieren
    ];
    const p = buildWeeklyProfile(records, "claude", NOW);
    // Montag: (4M + 2M) / 4 Vorkommen in 28 Tagen
    expect(p.avgTokensPerWeekday[1]).toBeCloseTo(1_500_000);
    expect(p.avgTokensPerWeekday[2]).toBeCloseTo(250_000);
    expect(p.avgTokensPerWeekday[3]).toBe(0);
    expect(p.weeksOfData).toBe(2);
  });
});

describe("computeWeeklyForecast", () => {
  const flatProfile: WeeklyProfile = {
    avgTokensPerWeekday: new Array(7).fill(2_400_000),
    weeksOfData: 4,
  };

  it("Profil-Prognose: findet den 100%-Schnittpunkt", () => {
    const fc = computeWeeklyForecast({
      weeklyUsedPercent: 50,
      weeklyResetsAt: new Date(NOW.getTime() + 144 * 3600_000).toISOString(),
      tokensInCurrentWindow: 12_000_000,
      burnRatePctPerHour: null,
      pace: null,
      profile: flatProfile,
      now: NOW,
    });
    expect(fc.primaryKind).toBe("profile");
    expect(fc.primaryLastsUntilReset).toBe(false);
    const hours = (new Date(fc.primaryAt!).getTime() - NOW.getTime()) / 3600_000;
    expect(hours).toBeGreaterThan(115);
    expect(hours).toBeLessThan(125);
  });

  it("Profil-Prognose: reicht bis zum Reset, wenn 100 % nicht erreicht wird", () => {
    const fc = computeWeeklyForecast({
      weeklyUsedPercent: 10,
      weeklyResetsAt: new Date(NOW.getTime() + 24 * 3600_000).toISOString(),
      tokensInCurrentWindow: 12_000_000,
      burnRatePctPerHour: null,
      pace: null,
      profile: flatProfile,
      now: NOW,
    });
    expect(fc.primaryLastsUntilReset).toBe(true);
    expect(fc.primaryAt).toBeNull();
  });

  it("fällt auf linear (pace) zurück, wenn das Profil zu dünn ist", () => {
    const fc = computeWeeklyForecast({
      weeklyUsedPercent: 60,
      weeklyResetsAt: new Date(NOW.getTime() + 48 * 3600_000).toISOString(),
      tokensInCurrentWindow: 12_000_000,
      burnRatePctPerHour: null,
      pace: {
        stage: "ahead", deltaPercent: 10, expectedUsedPercent: 50, actualUsedPercent: 60,
        etaSeconds: 36_000, willLastToReset: false,
      },
      profile: { avgTokensPerWeekday: new Array(7).fill(0), weeksOfData: 1 },
      now: NOW,
    });
    expect(fc.primaryKind).toBe("linear");
    expect(fc.primaryAt).toBe(new Date(NOW.getTime() + 36_000_000).toISOString());
  });

  it("linear: willLastToReset wird durchgereicht", () => {
    const fc = computeWeeklyForecast({
      weeklyUsedPercent: 20,
      weeklyResetsAt: new Date(NOW.getTime() + 48 * 3600_000).toISOString(),
      tokensInCurrentWindow: 0,
      burnRatePctPerHour: null,
      pace: {
        stage: "onTrack", deltaPercent: 0, expectedUsedPercent: 20, actualUsedPercent: 20,
        etaSeconds: null, willLastToReset: true,
      },
      profile: { avgTokensPerWeekday: new Array(7).fill(0), weeksOfData: 0 },
      now: NOW,
    });
    expect(fc.primaryKind).toBe("linear");
    expect(fc.primaryLastsUntilReset).toBe(true);
  });

  it("Burn-Rate-Prognose: Termin vor dem Reset", () => {
    const fc = computeWeeklyForecast({
      weeklyUsedPercent: 80,
      weeklyResetsAt: new Date(NOW.getTime() + 100 * 3600_000).toISOString(),
      tokensInCurrentWindow: 0,
      burnRatePctPerHour: 2,
      pace: null,
      profile: { avgTokensPerWeekday: new Array(7).fill(0), weeksOfData: 0 },
      now: NOW,
    });
    expect(fc.burnRateAt).toBe(new Date(NOW.getTime() + 10 * 3600_000).toISOString());
    expect(fc.burnRateLastsUntilReset).toBe(false);
  });

  it("Burn-Rate 0 %/h → reicht bis zum Reset", () => {
    const fc = computeWeeklyForecast({
      weeklyUsedPercent: 80,
      weeklyResetsAt: new Date(NOW.getTime() + 100 * 3600_000).toISOString(),
      tokensInCurrentWindow: 0,
      burnRatePctPerHour: 0,
      pace: null,
      profile: { avgTokensPerWeekday: new Array(7).fill(0), weeksOfData: 0 },
      now: NOW,
    });
    expect(fc.burnRateAt).toBeNull();
    expect(fc.burnRateLastsUntilReset).toBe(true);
  });

  it("Burn-Rate null → keine Sekundär-Prognose", () => {
    const fc = computeWeeklyForecast({
      weeklyUsedPercent: 80,
      weeklyResetsAt: null,
      tokensInCurrentWindow: 0,
      burnRatePctPerHour: null,
      pace: null,
      profile: { avgTokensPerWeekday: new Array(7).fill(0), weeksOfData: 0 },
      now: NOW,
    });
    expect(fc.burnRateLastsUntilReset).toBeNull();
    expect(fc.primaryAt).toBeNull();
  });
});
