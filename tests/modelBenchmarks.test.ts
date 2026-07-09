import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const FILE = path.join(__dirname, "..", "src", "config", "model-benchmarks.json");

describe("model-benchmarks.json", () => {
  const raw = () => JSON.parse(fs.readFileSync(FILE, "utf8")) as {
    indexes: Record<string, { source: string; asOf: string; scores: Record<string, unknown> }>;
  };

  it("exists and parses", () => {
    expect(() => raw()).not.toThrow();
  });

  it("has source and asOf in YYYY-MM or YYYY-MM-DD form", () => {
    for (const index of Object.values(raw().indexes)) {
      expect(index.source.length).toBeGreaterThan(0);
      expect(index.asOf).toMatch(/^\d{4}-\d{2}(-\d{2})?$/);
    }
  });

  it("all scores are finite numbers in plausible range", () => {
    for (const index of Object.values(raw().indexes)) {
      for (const [model, score] of Object.entries(index.scores)) {
        expect(typeof score, model).toBe("number");
        expect(score as number, model).toBeGreaterThan(0);
        expect(score as number, model).toBeLessThan(100);
      }
    }
  });

  it("all keys are normalized (no date suffix)", () => {
    for (const index of Object.values(raw().indexes)) {
      for (const model of Object.keys(index.scores)) {
        expect(model).not.toMatch(/-20\d{6}$/);
      }
    }
  });

  it("includes Coding Agent Index scores averaged from high reasoning upward", () => {
    const json = raw();

    expect(json.indexes.codingAgent.scores).toMatchObject({
      "claude-fable-5": 77,
      "claude-opus-4-8": 73,
      "gpt-5.5": 76,
      "gpt-5.6-sol": 79,
      "gpt-5.6-terra": 74,
      "gpt-5.6-luna": 71,
    });
    expect(json.indexes.codingAgent.source).toContain("Coding Agent Index");
  });

  it("explains that averaging applies only when multiple reasoning variants exist", () => {
    const json = JSON.parse(fs.readFileSync(FILE, "utf8")) as {
      note: string;
      indexes: Record<string, { reasoningNote: string }>;
    };

    expect(json.note).toContain("When multiple reasoning variants are available");
    for (const index of Object.values(json.indexes)) {
      expect(index.reasoningNote).toContain("When multiple reasoning variants are available");
    }
  });
});
