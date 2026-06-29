import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type UsageWindow = { name: string; usedPercent?: number };

function loadLiveHelpers(): {
  effectiveUsageWindow: (fiveH?: UsageWindow, weekly?: UsageWindow) => UsageWindow | null;
  effectiveUsageLabel: (win?: UsageWindow | null) => string;
} {
  const qb = {};
  const context = vm.createContext({
    window: { QB: qb },
    QB: qb,
    console,
    setInterval,
    clearInterval,
  });
  const script = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "tabs", "live.js"), "utf8");
  vm.runInContext(script, context);
  return (context.QB as any).__liveTest;
}

describe("live renderer helpers", () => {
  it("uses the weekly window as effective card usage when weekly is the limiting quota", () => {
    const helpers = loadLiveHelpers();
    const fiveHour = { name: "fiveHour", usedPercent: 12 };
    const weekly = { name: "weekly", usedPercent: 100 };

    expect(helpers.effectiveUsageWindow(fiveHour, weekly)).toBe(weekly);
    expect(helpers.effectiveUsageLabel(weekly)).toBe("Wk 100%");
  });

  it("keeps the five-hour window as effective card usage when it is higher", () => {
    const helpers = loadLiveHelpers();
    const fiveHour = { name: "fiveHour", usedPercent: 80 };
    const weekly = { name: "weekly", usedPercent: 40 };

    expect(helpers.effectiveUsageWindow(fiveHour, weekly)).toBe(fiveHour);
    expect(helpers.effectiveUsageLabel(fiveHour)).toBe("5h 80%");
  });

  it("returns null when neither quota window has a percentage", () => {
    const helpers = loadLiveHelpers();

    expect(helpers.effectiveUsageWindow({ name: "fiveHour" }, { name: "weekly" })).toBeNull();
    expect(helpers.effectiveUsageLabel(null)).toBe("—");
  });
});
