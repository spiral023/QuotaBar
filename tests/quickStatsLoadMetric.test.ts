import { describe, expect, it } from "vitest";
import { QuickStatsLoadMetric } from "../src/main/quickStatsLoadMetric";

describe("QuickStatsLoadMetric", () => {
  it("keeps the first successful Quick Stats load duration for the app run", () => {
    const metric = new QuickStatsLoadMetric();

    expect(metric.record(10_000)).toBe(true);
    expect(metric.valueMs).toBe(10_000);
    expect(metric.record(1_500)).toBe(false);
    expect(metric.valueMs).toBe(10_000);
  });

  it("ignores invalid durations without consuming the first measurement", () => {
    const metric = new QuickStatsLoadMetric();

    expect(metric.record(Number.NaN)).toBe(false);
    expect(metric.valueMs).toBeNull();
    expect(metric.record(2_000)).toBe(true);
    expect(metric.valueMs).toBe(2_000);
  });
});
