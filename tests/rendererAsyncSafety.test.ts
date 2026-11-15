import { describe, expect, it, vi } from "vitest";
import { analytics } from "./helpers/analyticsFixture";
import { flush, rendererHarness } from "./helpers/rendererHarness";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function data(cost: number) {
  return { ...analytics, dailyBuckets: [{ date: "2026-01-01", days: 1, claudeUSD: cost, codexUSD: 0 }] };
}

function harness(responses: unknown[]) {
  const h = rendererHarness({ "reports:get": [{ rows: [] }], "analytics:get": responses, "windowHistory:get": [{ entries: [], planChanges: [] }] });
  h.run("src/renderer/shared/ipc.js");
  h.run("src/renderer/tabs/analytics.js");
  const chart = vi.fn(() => ({ destroy() {}, update() {} }));
  h.QB.charts.createLine = chart;
  const costs = () => chart.mock.calls.filter((args: unknown[]) => (args[3] as { yFormat?: string })?.yFormat === "cost")
    .map((args: unknown[]) => (args[2] as Array<{ data: number[] }>)[0].data[0]);
  return { ...h, costs };
}

describe("analytics request ordering", () => {
  it("keeps the selected range when an older response arrives last", async () => {
    const old = deferred<ReturnType<typeof data>>();
    const h = harness([() => old.promise, data(22)]);
    const initial = h.QB.renderAnalytics();
    await flush();
    const from = h.document.requireElementById("an-from");
    from.value = "2026-01-01";
    await from.emit("change"); await flush();
    expect(h.costs().at(-1)).toBe(22);
    old.resolve(data(11)); await initial; await flush();
    expect(h.costs().at(-1)).toBe(22);
  });

  it("does not render or cache a response from before invalidation", async () => {
    const old = deferred<ReturnType<typeof data>>();
    const h = harness([() => old.promise, data(33)]);
    const initial = h.QB.renderAnalytics(); await flush();
    h.QB.clearAnalyticsCache();
    old.resolve(data(11)); await initial; await flush();
    expect(h.costs()).toEqual([]);
    await h.QB.renderAnalytics();
    expect(h.costs().at(-1)).toBe(33);
  });

  it("reloads an active view when settings invalidate an outstanding request", async () => {
    const old = deferred<ReturnType<typeof data>>();
    const h = harness([() => old.promise, data(44)]);
    const initial = h.QB.renderAnalytics(); await flush();
    h.document.requireElementById("tab-live").classList.remove("active");
    h.document.requireElementById("tab-analytics").classList.add("active");
    h.QB.clearAnalyticsCache(); await flush();
    expect(h.costs().at(-1)).toBe(44);
    old.resolve(data(11)); await initial; await flush();
    expect(h.costs().at(-1)).toBe(44);
  });

  it("renders prefetched replacement data when revisiting an initialized tab", async () => {
    const h = harness([data(11), data(66)]);
    await h.QB.renderAnalytics();
    h.QB.clearAnalyticsCache(); h.QB.prefetchAnalytics(); await flush();
    await h.QB.renderAnalytics();
    expect(h.costs().at(-1)).toBe(66);
  });
});

describe("update text rendering", () => {
  it("renders error and version markup as literal text", async () => {
    const totals = { fileCount: 0, totalBytes: 0, lastModifiedAt: null };
    const h = rendererHarness({
      "system:get": [{ generatedAt: "2026-01-01T00:00:00Z", totals, agents: [], categories: [], app: { totals, paths: [], variant: { label: "Development" } } }],
      "settings:get": [{}], "dataSources:get": [{}],
      "update:get-state": [{ status: "error", currentVersion: "2.4.0", error: '<strong id="injected-error">synthetic</strong>' }],
    });
    h.run("src/renderer/shared/format.js"); h.run("src/renderer/tabs/system.js");
    await h.QB.renderSystem();
    expect(h.document.getElementById("injected-error")).toBeNull();
    h.handlers.get("update:state")!({ status: "available", currentVersion: "2.4.0", newVersion: '<i id="injected-version">next</i>' });
    expect(h.document.getElementById("injected-version")).toBeNull();
  });
});
