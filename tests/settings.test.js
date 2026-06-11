"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const settings_1 = require("../src/config/settings");
(0, vitest_1.describe)("normalizeSettings costWindow", () => {
    (0, vitest_1.it)("defaults to '30d'", () => {
        const result = (0, settings_1.normalizeSettings)({ ...settings_1.defaultSettings });
        (0, vitest_1.expect)(result.costWindow).toBe("30d");
    });
    (0, vitest_1.it)("accepts '7d'", () => {
        const result = (0, settings_1.normalizeSettings)({ ...settings_1.defaultSettings, costWindow: "7d" });
        (0, vitest_1.expect)(result.costWindow).toBe("7d");
    });
    (0, vitest_1.it)("accepts '30d'", () => {
        const result = (0, settings_1.normalizeSettings)({ ...settings_1.defaultSettings, costWindow: "30d" });
        (0, vitest_1.expect)(result.costWindow).toBe("30d");
    });
    (0, vitest_1.it)("rejects unknown value, falls back to '30d'", () => {
        const result = (0, settings_1.normalizeSettings)({ ...settings_1.defaultSettings, costWindow: "bogus" });
        (0, vitest_1.expect)(result.costWindow).toBe("30d");
    });
});
(0, vitest_1.describe)("normalizeSettings viewMode", () => {
    (0, vitest_1.it)("defaults viewMode to 'dashboard'", () => {
        const result = (0, settings_1.normalizeSettings)({ ...settings_1.defaultSettings });
        (0, vitest_1.expect)(result.viewMode).toBe("dashboard");
    });
    (0, vitest_1.it)("accepts viewMode 'compact'", () => {
        const result = (0, settings_1.normalizeSettings)({ ...settings_1.defaultSettings, viewMode: "compact" });
        (0, vitest_1.expect)(result.viewMode).toBe("compact");
    });
    (0, vitest_1.it)("rejects unknown viewMode, falls back to 'dashboard'", () => {
        const result = (0, settings_1.normalizeSettings)({ ...settings_1.defaultSettings, viewMode: "sidebar" });
        (0, vitest_1.expect)(result.viewMode).toBe("dashboard");
    });
    (0, vitest_1.it)("defaults insightsPanelOpen to false", () => {
        const result = (0, settings_1.normalizeSettings)({ ...settings_1.defaultSettings });
        (0, vitest_1.expect)(result.insightsPanelOpen).toBe(false);
    });
});
(0, vitest_1.describe)("debugLog settings", () => {
    (0, vitest_1.it)("defaults debugLog.enabled to true", () => {
        (0, vitest_1.expect)(settings_1.defaultSettings.debugLog).toEqual({ enabled: true });
    });
    (0, vitest_1.it)("normalizes missing debugLog block to default", () => {
        const out = (0, settings_1.normalizeSettings)({ ...settings_1.defaultSettings, debugLog: undefined });
        (0, vitest_1.expect)(out.debugLog).toEqual({ enabled: true });
    });
    (0, vitest_1.it)("coerces non-boolean enabled values", () => {
        const out = (0, settings_1.normalizeSettings)({ ...settings_1.defaultSettings, debugLog: { enabled: "no" } });
        (0, vitest_1.expect)(out.debugLog).toEqual({ enabled: true }); // any truthy non-bool becomes true
    });
    (0, vitest_1.it)("respects explicit false", () => {
        const out = (0, settings_1.normalizeSettings)({ ...settings_1.defaultSettings, debugLog: { enabled: false } });
        (0, vitest_1.expect)(out.debugLog).toEqual({ enabled: false });
    });
});
