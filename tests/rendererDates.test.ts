import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type Range = { from: string; to: string };
type DateHelpers = {
  localDayKey: (date: Date) => string;
  localDayKeyDaysAgo: (now: Date, days: number) => string;
  presetRange: (preset: string, minDate: string | null, now?: Date) => Range;
};

function loadDateHelpers(): DateHelpers {
  const qb = {};
  // Share the host Date so `instanceof Date` holds for dates built in the test.
  const context = vm.createContext({ window: { QB: qb }, QB: qb, Date });
  const script = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "shared", "dates.js"), "utf8");
  vm.runInContext(script, context);
  return context.QB as DateHelpers;
}

// Dates are built from local components, so the assertions hold in any time zone.
describe("renderer date helpers", () => {
  const { localDayKey, presetRange } = loadDateHelpers();

  it("keeps today as the local day shortly after local midnight", () => {
    const justAfterMidnight = new Date(2026, 10, 23, 0, 30);
    expect(localDayKey(justAfterMidnight)).toBe("2026-11-23");
    expect(presetRange("30d", null, justAfterMidnight).to).toBe("2026-11-23");
  });

  it("counts day presets inclusively in calendar days", () => {
    const now = new Date(2026, 10, 23, 12, 0);
    expect(presetRange("7d", null, now)).toEqual({ from: "2026-11-17", to: "2026-11-23" });
    expect(presetRange("30d", null, now)).toEqual({ from: "2026-10-25", to: "2026-11-23" });
    expect(presetRange("month", null, now)).toEqual({ from: "2026-11-01", to: "2026-11-23" });
    expect(presetRange("year", null, now)).toEqual({ from: "2026-01-01", to: "2026-11-23" });
  });

  it("does not drift across a daylight saving change", () => {
    const afterSpringForward = new Date(2026, 2, 30, 0, 30);
    expect(presetRange("7d", null, afterSpringForward).from).toBe("2026-03-24");
  });

  it("starts the week on Monday", () => {
    for (let offset = 0; offset < 7; offset++) {
      const now = new Date(2026, 10, 16 + offset, 9, 0);
      const { from } = presetRange("week", null, now);
      const [y, m, d] = from.split("-").map(Number);
      const start = new Date(y, m - 1, d);
      expect(start.getDay()).toBe(1);
      expect((now.getTime() - start.getTime()) / 864e5).toBeLessThan(7);
    }
  });

  it("uses the first usage day for all time and falls back to 90 days", () => {
    const now = new Date(2026, 10, 23, 12, 0);
    expect(presetRange("all", "2025-06-01", now)).toEqual({ from: "2025-06-01", to: "2026-11-23" });
    expect(presetRange("all", null, now)).toEqual({ from: "2026-08-26", to: "2026-11-23" });
  });
});
