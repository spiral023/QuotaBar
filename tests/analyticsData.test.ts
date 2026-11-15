import { describe, expect, it } from "vitest";
import { rendererHarness } from "./helpers/rendererHarness";

describe("analytics data cache", () => {
  it("deduplicates requests, separates timezones and evicts the least recently used range", async () => {
    const h = rendererHarness({ "analytics:get": [{}, {}, {}, {}] });
    h.run("src/renderer/shared/ipc.js"); h.run("src/renderer/tabs/analytics-data.js");
    const cache = h.QB.createAnalyticsData(2);
    const a = { since: "2026-01-01", timeZone: "UTC" }, b = { since: "2026-02-01", timeZone: "UTC" };
    expect(cache.load(a)).toBe(cache.load(a));
    await cache.load(b); await cache.load(a);
    await cache.load({ ...a, timeZone: "Europe/Vienna" });
    expect(cache.has(a)).toBe(true); expect(cache.has(b)).toBe(false);
    expect(h.calls).toHaveLength(3);
  });

  it("does not retain preparing responses", async () => {
    const h = rendererHarness({ "analytics:get": [{ portableDataPreparing: true }, {}] });
    h.run("src/renderer/shared/ipc.js"); h.run("src/renderer/tabs/analytics-data.js");
    const cache = h.QB.createAnalyticsData();
    await cache.load({}); expect(cache.has({})).toBe(false);
    await cache.load({}); expect(cache.has({})).toBe(true);
    expect(h.calls).toHaveLength(2);
  });
});
