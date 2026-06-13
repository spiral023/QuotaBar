import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const FILE = path.join(__dirname, "..", "src", "config", "model-benchmarks.json");

describe("model-benchmarks.json", () => {
  const raw = () => JSON.parse(fs.readFileSync(FILE, "utf8")) as {
    source: string; asOf: string; scores: Record<string, unknown>;
  };

  it("exists and parses", () => {
    expect(() => raw()).not.toThrow();
  });

  it("has source and asOf in YYYY-MM or YYYY-MM-DD form", () => {
    const json = raw();
    expect(json.source.length).toBeGreaterThan(0);
    expect(json.asOf).toMatch(/^\d{4}-\d{2}(-\d{2})?$/);
  });

  it("all scores are finite numbers in plausible range", () => {
    for (const [model, score] of Object.entries(raw().scores)) {
      expect(typeof score, model).toBe("number");
      expect(score as number, model).toBeGreaterThan(0);
      expect(score as number, model).toBeLessThan(100);
    }
  });

  it("all keys are normalized (no date suffix)", () => {
    for (const model of Object.keys(raw().scores)) {
      expect(model).not.toMatch(/-20\d{6}$/);
    }
  });
});
