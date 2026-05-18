import { describe, it, expect } from "vitest";
import { normalizeSettings, defaultSettings } from "../src/config/settings";

describe("normalizeSettings costWindow", () => {
  it("defaults to 'billing'", () => {
    const result = normalizeSettings({ ...defaultSettings });
    expect(result.costWindow).toBe("billing");
  });

  it("accepts '7d'", () => {
    const result = normalizeSettings({ ...defaultSettings, costWindow: "7d" });
    expect(result.costWindow).toBe("7d");
  });

  it("accepts '30d'", () => {
    const result = normalizeSettings({ ...defaultSettings, costWindow: "30d" });
    expect(result.costWindow).toBe("30d");
  });

  it("rejects unknown value, falls back to 'billing'", () => {
    const result = normalizeSettings({ ...defaultSettings, costWindow: "bogus" as never });
    expect(result.costWindow).toBe("billing");
  });
});
