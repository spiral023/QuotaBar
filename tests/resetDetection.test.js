"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const resetDetection_1 = require("../src/usage/resetDetection");
function snap(provider, windows, status = "ok") {
    return {
        provider,
        status,
        windows,
        updatedAt: "2024-01-01T00:00:00.000Z",
    };
}
(0, vitest_1.describe)("detectResets", () => {
    (0, vitest_1.it)("emits ResetEvent when fiveHour window goes from 100% to 0%", () => {
        const prev = snap("codex", [{ name: "fiveHour", usedPercent: 100 }]);
        const next = snap("codex", [{ name: "fiveHour", usedPercent: 0 }]);
        (0, vitest_1.expect)((0, resetDetection_1.detectResets)(prev, next)).toEqual([{ provider: "codex", windowName: "fiveHour" }]);
    });
    (0, vitest_1.it)("emits ResetEvent for weekly window reset", () => {
        const prev = snap("claude", [{ name: "weekly", usedPercent: 99.5 }]);
        const next = snap("claude", [{ name: "weekly", usedPercent: 0 }]);
        (0, vitest_1.expect)((0, resetDetection_1.detectResets)(prev, next)).toEqual([{ provider: "claude", windowName: "weekly" }]);
    });
    (0, vitest_1.it)("emits nothing when prev was below threshold (80%)", () => {
        const prev = snap("codex", [{ name: "fiveHour", usedPercent: 80 }]);
        const next = snap("codex", [{ name: "fiveHour", usedPercent: 0 }]);
        (0, vitest_1.expect)((0, resetDetection_1.detectResets)(prev, next)).toEqual([]);
    });
    (0, vitest_1.it)("emits nothing when next is above near-empty threshold (50%)", () => {
        const prev = snap("codex", [{ name: "fiveHour", usedPercent: 100 }]);
        const next = snap("codex", [{ name: "fiveHour", usedPercent: 50 }]);
        (0, vitest_1.expect)((0, resetDetection_1.detectResets)(prev, next)).toEqual([]);
    });
    (0, vitest_1.it)("emits nothing when next status is error", () => {
        const prev = snap("codex", [{ name: "fiveHour", usedPercent: 100 }]);
        const next = snap("codex", [{ name: "fiveHour", usedPercent: 0 }], "error");
        (0, vitest_1.expect)((0, resetDetection_1.detectResets)(prev, next)).toEqual([]);
    });
    (0, vitest_1.it)("emits nothing when next status is stale", () => {
        const prev = snap("codex", [{ name: "fiveHour", usedPercent: 100 }]);
        const next = snap("codex", [{ name: "fiveHour", usedPercent: 0 }], "stale");
        (0, vitest_1.expect)((0, resetDetection_1.detectResets)(prev, next)).toEqual([]);
    });
    (0, vitest_1.it)("emits nothing when next status is not_authenticated", () => {
        const prev = snap("codex", [{ name: "fiveHour", usedPercent: 100 }]);
        const next = snap("codex", [{ name: "fiveHour", usedPercent: 0 }], "not_authenticated");
        (0, vitest_1.expect)((0, resetDetection_1.detectResets)(prev, next)).toEqual([]);
    });
    (0, vitest_1.it)("emits nothing when prev status is error (recovery from error is not a reset)", () => {
        const prev = snap("codex", [{ name: "fiveHour", usedPercent: 100 }], "error");
        const next = snap("codex", [{ name: "fiveHour", usedPercent: 0 }]);
        (0, vitest_1.expect)((0, resetDetection_1.detectResets)(prev, next)).toEqual([]);
    });
    (0, vitest_1.it)("emits nothing when no previous snapshot (first refresh)", () => {
        const next = snap("codex", [{ name: "fiveHour", usedPercent: 0 }]);
        (0, vitest_1.expect)((0, resetDetection_1.detectResets)(undefined, next)).toEqual([]);
    });
    (0, vitest_1.it)("emits multiple events when multiple windows reset simultaneously", () => {
        const prev = snap("claude", [
            { name: "fiveHour", usedPercent: 100 },
            { name: "weekly", usedPercent: 99.5 },
        ]);
        const next = snap("claude", [
            { name: "fiveHour", usedPercent: 0 },
            { name: "weekly", usedPercent: 1 },
        ]);
        const events = (0, resetDetection_1.detectResets)(prev, next);
        (0, vitest_1.expect)(events).toHaveLength(2);
        (0, vitest_1.expect)(events).toContainEqual({ provider: "claude", windowName: "fiveHour" });
        (0, vitest_1.expect)(events).toContainEqual({ provider: "claude", windowName: "weekly" });
    });
    (0, vitest_1.it)("threshold boundary: prev exactly 99.5% → emits", () => {
        const prev = snap("codex", [{ name: "fiveHour", usedPercent: 99.5 }]);
        const next = snap("codex", [{ name: "fiveHour", usedPercent: 0 }]);
        (0, vitest_1.expect)((0, resetDetection_1.detectResets)(prev, next)).toHaveLength(1);
    });
    (0, vitest_1.it)("threshold boundary: prev 99.4% → no event", () => {
        const prev = snap("codex", [{ name: "fiveHour", usedPercent: 99.4 }]);
        const next = snap("codex", [{ name: "fiveHour", usedPercent: 0 }]);
        (0, vitest_1.expect)((0, resetDetection_1.detectResets)(prev, next)).toEqual([]);
    });
    (0, vitest_1.it)("threshold boundary: next exactly 1% → emits", () => {
        const prev = snap("codex", [{ name: "fiveHour", usedPercent: 100 }]);
        const next = snap("codex", [{ name: "fiveHour", usedPercent: 1 }]);
        (0, vitest_1.expect)((0, resetDetection_1.detectResets)(prev, next)).toHaveLength(1);
    });
    (0, vitest_1.it)("threshold boundary: next 1.1% → no event", () => {
        const prev = snap("codex", [{ name: "fiveHour", usedPercent: 100 }]);
        const next = snap("codex", [{ name: "fiveHour", usedPercent: 1.1 }]);
        (0, vitest_1.expect)((0, resetDetection_1.detectResets)(prev, next)).toEqual([]);
    });
    (0, vitest_1.it)("emits nothing when prev window has no usedPercent", () => {
        const prev = snap("codex", [{ name: "fiveHour" }]);
        const next = snap("codex", [{ name: "fiveHour", usedPercent: 0 }]);
        (0, vitest_1.expect)((0, resetDetection_1.detectResets)(prev, next)).toEqual([]);
    });
    (0, vitest_1.it)("emits nothing when next window has no usedPercent", () => {
        const prev = snap("codex", [{ name: "fiveHour", usedPercent: 100 }]);
        const next = snap("codex", [{ name: "fiveHour" }]);
        (0, vitest_1.expect)((0, resetDetection_1.detectResets)(prev, next)).toEqual([]);
    });
});
