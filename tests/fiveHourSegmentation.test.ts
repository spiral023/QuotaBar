import { describe, expect, it } from "vitest";
import {
  FIVE_HOUR_RESET_DROP_PCT,
  isFiveHourResetByResetsAt,
  isFiveHourResetConfirmedByDrop,
} from "../src/usage/weeklyTransition";

const T0 = "2026-07-13T10:00:00.000Z";
const T1 = "2026-07-13T15:00:00.000Z";

describe("drop-confirmed 5h reset rule", () => {
  it("needs a previous point", () => {
    expect(isFiveHourResetConfirmedByDrop(null, { pct: 0, resetsAt: T1 })).toBe(false);
  });

  it("counts a resetsAt change only together with falling usage", () => {
    expect(isFiveHourResetConfirmedByDrop({ pct: 40, resetsAt: T0 }, { pct: 2, resetsAt: T1 })).toBe(true);
    // Codex idle windows roll resetsAt forward while usage stays flat.
    expect(isFiveHourResetConfirmedByDrop({ pct: 3, resetsAt: T0 }, { pct: 3, resetsAt: T1 })).toBe(false);
  });

  it("counts a large drop without any resetsAt", () => {
    expect(isFiveHourResetConfirmedByDrop({ pct: 60, resetsAt: null }, { pct: 60 - FIVE_HOUR_RESET_DROP_PCT - 1, resetsAt: null })).toBe(true);
    expect(isFiveHourResetConfirmedByDrop({ pct: 60, resetsAt: null }, { pct: 60 - FIVE_HOUR_RESET_DROP_PCT, resetsAt: null })).toBe(false);
  });

  it("ignores resetsAt jitter within the tolerance", () => {
    expect(isFiveHourResetConfirmedByDrop(
      { pct: 40, resetsAt: T0 },
      { pct: 39, resetsAt: "2026-07-13T10:00:30.000Z" },
    )).toBe(false);
  });
});

describe("resetsAt-only 5h reset rule", () => {
  it("splits on any resetsAt change beyond the tolerance", () => {
    expect(isFiveHourResetByResetsAt(T0, T1)).toBe(true);
    expect(isFiveHourResetByResetsAt(T0, "2026-07-13T10:00:30.000Z")).toBe(false);
    expect(isFiveHourResetByResetsAt(null, T1)).toBe(false);
  });
});
