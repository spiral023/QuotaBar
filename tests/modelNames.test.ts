import { describe, it, expect } from "vitest";
import { normalizeModelName, isIgnoredModel } from "../src/shared/modelNames";

describe("normalizeModelName", () => {
  it("strips date suffix from Claude model names", () => {
    expect(normalizeModelName("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(normalizeModelName("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4-5");
  });

  it("leaves names without date suffix unchanged", () => {
    expect(normalizeModelName("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(normalizeModelName("gpt-5.3-codex")).toBe("gpt-5.3-codex");
    expect(normalizeModelName("gpt-5-codex-mini")).toBe("gpt-5-codex-mini");
  });

  it("does not strip version-like fragments that are not dates", () => {
    expect(normalizeModelName("gpt-5.4-mini")).toBe("gpt-5.4-mini");
  });
});

describe("isIgnoredModel", () => {
  it("ignores synthetic, unknown and empty", () => {
    expect(isIgnoredModel("<synthetic>")).toBe(true);
    expect(isIgnoredModel("unknown")).toBe(true);
    expect(isIgnoredModel("")).toBe(true);
  });

  it("keeps real model names", () => {
    expect(isIgnoredModel("claude-opus-4-8")).toBe(false);
    expect(isIgnoredModel("gpt-5.5")).toBe(false);
  });
});
