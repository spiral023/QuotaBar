import { describe, it, expect } from "vitest";
import { normalizeSettings, defaultSettings } from "../src/config/settings";

describe("normalizeSettings costWindow", () => {
  it("defaults refresh interval to 120 seconds", () => {
    const result = normalizeSettings({ ...defaultSettings });
    expect(result.pollIntervalSeconds).toBe(120);
  });

  it("defaults to '30d'", () => {
    const result = normalizeSettings({ ...defaultSettings });
    expect(result.costWindow).toBe("30d");
  });

  it("accepts '7d'", () => {
    const result = normalizeSettings({ ...defaultSettings, costWindow: "7d" });
    expect(result.costWindow).toBe("7d");
  });

  it("accepts '30d'", () => {
    const result = normalizeSettings({ ...defaultSettings, costWindow: "30d" });
    expect(result.costWindow).toBe("30d");
  });

  it("rejects unknown value, falls back to '30d'", () => {
    const result = normalizeSettings({ ...defaultSettings, costWindow: "bogus" as never });
    expect(result.costWindow).toBe("30d");
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

describe("debugLog settings", () => {
  it("defaults debugLog.enabled to true", () => {
    expect(defaultSettings.debugLog).toEqual({ enabled: true });
  });

  it("normalizes missing debugLog block to default", () => {
    const out = normalizeSettings({ ...defaultSettings, debugLog: undefined as never });
    expect(out.debugLog).toEqual({ enabled: true });
  });

  it("coerces non-boolean enabled values", () => {
    const out = normalizeSettings({ ...defaultSettings, debugLog: { enabled: "no" as unknown as boolean } });
    expect(out.debugLog).toEqual({ enabled: true }); // any truthy non-bool becomes true
  });

  it("respects explicit false", () => {
    const out = normalizeSettings({ ...defaultSettings, debugLog: { enabled: false } });
    expect(out.debugLog).toEqual({ enabled: false });
  });
});

describe("normalizeSettings provider roots", () => {
  it("defaults to no additional provider roots", () => {
    expect(defaultSettings.claudeRoots).toEqual([]);
    expect(defaultSettings.codexHomes).toEqual([]);
  });

  it("keeps unique non-empty Claude root entries", () => {
    const out = normalizeSettings({
      ...defaultSettings,
      claudeRoots: [" C:\\Users\\asi\\.claude ", "", "C:\\Users\\asi\\.claude", "\\\\wsl.localhost\\Ubuntu\\home\\asi\\.claude"],
    });

    expect(out.claudeRoots).toEqual([
      "C:\\Users\\asi\\.claude",
      "\\\\wsl.localhost\\Ubuntu\\home\\asi\\.claude",
    ]);
  });

  it("keeps unique non-empty Codex home entries", () => {
    const out = normalizeSettings({
      ...defaultSettings,
      codexHomes: [" C:\\Users\\asi\\.codex ", "", "C:\\Users\\asi\\.codex", "\\\\wsl.localhost\\Ubuntu\\home\\asi\\.codex"],
    });

    expect(out.codexHomes).toEqual([
      "C:\\Users\\asi\\.codex",
      "\\\\wsl.localhost\\Ubuntu\\home\\asi\\.codex",
    ]);
  });

  it("rejects non-array provider root settings", () => {
    const out = normalizeSettings({ ...defaultSettings, claudeRoots: "x" as never, codexHomes: "x" as never });
    expect(out.claudeRoots).toEqual([]);
    expect(out.codexHomes).toEqual([]);
  });
});

describe("normalizeSettings providerOrder", () => {
  it("defaults to Claude followed by Codex", () => {
    expect(defaultSettings.providerOrder).toEqual(["claude", "codex"]);
  });

  it("normalizes duplicate, unknown, and missing providers", () => {
    const out = normalizeSettings({
      ...defaultSettings,
      providerOrder: ["codex", "invalid", "codex"],
    });

    expect(out.providerOrder).toEqual(["codex", "claude"]);
  });
});

describe("normalizeSettings minModelTokenSharePct", () => {
  it("defaults to 0 (filter disabled)", () => {
    expect(defaultSettings.minModelTokenSharePct).toBe(0);
  });

  it("keeps a valid in-range value", () => {
    const out = normalizeSettings({ ...defaultSettings, minModelTokenSharePct: 10 });
    expect(out.minModelTokenSharePct).toBe(10);
  });

  it("clamps values above 100 and below 0", () => {
    expect(normalizeSettings({ ...defaultSettings, minModelTokenSharePct: 150 }).minModelTokenSharePct).toBe(100);
    expect(normalizeSettings({ ...defaultSettings, minModelTokenSharePct: -5 }).minModelTokenSharePct).toBe(0);
  });

  it("falls back to default for non-numeric input", () => {
    const out = normalizeSettings({ ...defaultSettings, minModelTokenSharePct: "abc" as never });
    expect(out.minModelTokenSharePct).toBe(0);
  });

  it("allows an explicit positive threshold", () => {
    const out = normalizeSettings({ ...defaultSettings, minModelTokenSharePct: 5 });
    expect(out.minModelTokenSharePct).toBe(5);
  });
});
