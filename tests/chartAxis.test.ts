import { describe, expect, it } from "vitest";
import { rendererHarness } from "./helpers/rendererHarness";

describe("cost chart axes", () => {
  it("distinguishes cent and sub-cent ticks without changing integer scales", () => {
    const h = rendererHarness({}); h.run("src/renderer/shared/charts.js");
    const chart = h.QB.charts.createLine({}, [], [], { yFormat: "cost" });
    const format = chart.options.scales.y.ticks.callback;
    expect(format(.1, 0, [{ value: 0 }, { value: .1 }])).toBe("$0.1");
    expect(format(.25, 0, [{ value: 0 }, { value: .25 }])).toBe("$0.25");
    expect(format(.001, 0, [{ value: 0 }, { value: .001 }])).toBe("$0.001");
    expect(format(100, 0, [{ value: 0 }, { value: 50 }])).toBe("$100");
  });
});
