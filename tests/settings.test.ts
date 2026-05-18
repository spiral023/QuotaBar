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

describe("normalizeSettings viewMode", () => {
  it("defaults viewMode to 'dashboard'", () => {
    const result = normalizeSettings({ ...defaultSettings });
    expect(result.viewMode).toBe("dashboard");
  });

  it("accepts viewMode 'compact'", () => {
    const result = normalizeSettings({ ...defaultSettings, viewMode: "compact" });
    expect(result.viewMode).toBe("compact");
  });

  it("rejects unknown viewMode, falls back to 'dashboard'", () => {
    const result = normalizeSettings({ ...defaultSettings, viewMode: "sidebar" as never });
    expect(result.viewMode).toBe("dashboard");
  });

  it("defaults insightsPanelOpen to false", () => {
    const result = normalizeSettings({ ...defaultSettings });
    expect(result.insightsPanelOpen).toBe(false);
  });
});
