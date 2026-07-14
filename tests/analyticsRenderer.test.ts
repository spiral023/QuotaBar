import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type LineDataset = { label: string; data: number[] };

function loadAnalyticsHelpers(): {
  activityHeatColor: (value: number, boost?: number) => string;
  statTooltip: (label: string) => string;
  visibleLineDatasets: (provider: string, datasets: LineDataset[]) => LineDataset[];
  weekdayLabel: (day: { day?: number; label: string }) => string;
} {
  const qb = {};
  const context = vm.createContext({
    window: { QB: qb },
    QB: qb,
    console,
  });
  const script = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "tabs", "analytics.js"), "utf8");
  vm.runInContext(script, context);
  return (context.QB as any).__analyticsTest;
}

describe("analytics renderer helpers", () => {
  const datasets: LineDataset[] = [
    { label: "Claude", data: [1] },
    { label: "Codex", data: [2] },
  ];

  it("keeps both API cost datasets visible for the all provider filter", () => {
    const helpers = loadAnalyticsHelpers();

    expect(helpers.visibleLineDatasets("all", datasets).map((d) => d.label)).toEqual(["Claude", "Codex"]);
  });

  it("shows only the selected provider dataset", () => {
    const helpers = loadAnalyticsHelpers();

    expect(helpers.visibleLineDatasets("claude", datasets).map((d) => d.label)).toEqual(["Claude"]);
    expect(helpers.visibleLineDatasets("codex", datasets).map((d) => d.label)).toEqual(["Codex"]);
  });

  it("uses a neutral aggregate activity color instead of the Claude provider color", () => {
    const helpers = loadAnalyticsHelpers();

    expect(helpers.activityHeatColor(1)).toBe("rgba(125,220,196,1)");
    expect(helpers.activityHeatColor(1)).not.toBe("rgba(218,120,91,1)");
  });

  it("renders weekday labels in English", () => {
    const helpers = loadAnalyticsHelpers();

    expect(helpers.weekdayLabel({ day: 0, label: "Sonntag" })).toBe("Sunday");
    expect(helpers.weekdayLabel({ day: 3, label: "Mittwoch" })).toBe("Wednesday");
  });

  it("exposes English explanations for activity and efficiency KPI tooltips", () => {
    const helpers = loadAnalyticsHelpers();

    expect(helpers.statTooltip("Active days")).toContain("days in the selected period");
    expect(helpers.statTooltip("$/1k output")).toContain("API cost divided by output tokens");
  });

  it("does not cache or render analytics preparing responses", () => {
    const script = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "tabs", "analytics.js"), "utf8");
    expect(script).toContain("QB.isPortableDataPreparing(data)");
    expect(script).toContain("Preparing data");
    expect(script).toMatch(/isPortableDataPreparing\(data\)[\s\S]{0,220}_cache\.delete\(key\)/);
  });

  it("keeps preparing window history out of its renderer cache", () => {
    const script = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "tabs", "analytics.js"), "utf8");
    expect(script).toMatch(/windowHistory:get[\s\S]{0,220}isPortableDataPreparing\(_whData\)/);
  });
});
