import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const MODELS_TAB = path.join(__dirname, "..", "src", "renderer", "tabs", "models.js");

function loadModelsHelpers(): {
  benchmarkAxisTitle: (benchmark: { label: string }) => string;
} {
  const qb = { modelsCalc: {} };
  const context = vm.createContext({ window: { QB: qb }, QB: qb, Chart: {} });
  vm.runInContext(fs.readFileSync(MODELS_TAB, "utf8"), context);
  return (context.QB as any).__modelsTest;
}

describe("models renderer", () => {
  it("shows the selected benchmark methodology below the scatter chart", () => {
    const script = fs.readFileSync(MODELS_TAB, "utf8");

    expect(script).toContain("benchmark.methodology");
    expect(script).toContain("benchmark.reasoningNote");
    expect(script).toContain("methodologyLink.dataset.methodologyUrl");
  });

  it("uses the selected benchmark label for the chart axis", () => {
    const helpers = loadModelsHelpers();

    expect(helpers.benchmarkAxisTitle({ label: "Intelligence" })).toBe("Intelligence Index");
    expect(helpers.benchmarkAxisTitle({ label: "Coding Agent" })).toBe("Coding Agent Index");
  });

  it("updates only benchmark-dependent content when the selector changes", () => {
    const script = fs.readFileSync(MODELS_TAB, "utf8");
    const start = script.indexOf("document.querySelectorAll('[data-benchmark-index]')");
    const end = script.indexOf("document.getElementById('mod-methodology-link')", start);
    const handler = script.slice(start, end);

    expect(handler).toContain("renderBenchmarkView");
    expect(handler).not.toContain("renderUI()");
  });

  it("uses a button for the IPC methodology action", () => {
    const script = fs.readFileSync(MODELS_TAB, "utf8");

    expect(script).toContain('<button type="button" class="mod-methodology-link" id="mod-methodology-link"');
    expect(script).not.toContain('<a href="#" id="mod-methodology-link"');
  });
});
