"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const iconState_1 = require("../src/icon/iconState");
function snap(provider, status = "ok", windows = []) {
    return {
        provider,
        status,
        windows: windows,
        updatedAt: "2024-01-01T00:00:00.000Z",
    };
}
(0, vitest_1.describe)("buildIconState", () => {
    (0, vitest_1.it)("returns codex bar with usedPercent from fiveHour window", () => {
        const state = (0, iconState_1.buildIconState)([snap("codex", "ok", [{ name: "fiveHour", usedPercent: 75 }])]);
        (0, vitest_1.expect)(state.codex).toEqual({ usedPercent: 75, isStale: false });
        (0, vitest_1.expect)(state.claude).toBeUndefined();
    });
    (0, vitest_1.it)("returns claude bar with usedPercent from fiveHour window", () => {
        const state = (0, iconState_1.buildIconState)([snap("claude", "ok", [{ name: "fiveHour", usedPercent: 50 }])]);
        (0, vitest_1.expect)(state.claude).toEqual({ usedPercent: 50, isStale: false });
        (0, vitest_1.expect)(state.codex).toBeUndefined();
    });
    (0, vitest_1.it)("returns bar with isStale=true for stale provider", () => {
        const state = (0, iconState_1.buildIconState)([snap("codex", "stale", [{ name: "fiveHour", usedPercent: 90 }])]);
        (0, vitest_1.expect)(state.codex).toEqual({ usedPercent: 90, isStale: true });
    });
    (0, vitest_1.it)("returns undefined for not_authenticated provider", () => {
        const state = (0, iconState_1.buildIconState)([snap("codex", "not_authenticated")]);
        (0, vitest_1.expect)(state.codex).toBeUndefined();
    });
    (0, vitest_1.it)("returns undefined for error provider", () => {
        const state = (0, iconState_1.buildIconState)([snap("codex", "error")]);
        (0, vitest_1.expect)(state.codex).toBeUndefined();
    });
    (0, vitest_1.it)("returns usedPercent=undefined when fiveHour window exists but has no usedPercent", () => {
        const state = (0, iconState_1.buildIconState)([snap("codex", "ok", [{ name: "fiveHour" }])]);
        (0, vitest_1.expect)(state.codex).toEqual({ usedPercent: undefined, isStale: false });
    });
    (0, vitest_1.it)("returns usedPercent=undefined when no fiveHour window present", () => {
        const state = (0, iconState_1.buildIconState)([snap("codex", "ok", [{ name: "weekly", usedPercent: 30 }])]);
        (0, vitest_1.expect)(state.codex).toEqual({ usedPercent: undefined, isStale: false });
    });
    (0, vitest_1.it)("sets hasError=true when any snapshot is stale", () => {
        const state = (0, iconState_1.buildIconState)([snap("codex", "ok"), snap("claude", "stale")]);
        (0, vitest_1.expect)(state.hasError).toBe(true);
    });
    (0, vitest_1.it)("sets hasError=true when any snapshot has error status", () => {
        const state = (0, iconState_1.buildIconState)([snap("codex", "ok"), snap("claude", "error")]);
        (0, vitest_1.expect)(state.hasError).toBe(true);
    });
    (0, vitest_1.it)("sets hasError=false when no stale snapshots", () => {
        const state = (0, iconState_1.buildIconState)([snap("codex", "ok"), snap("claude", "ok")]);
        (0, vitest_1.expect)(state.hasError).toBe(false);
    });
    (0, vitest_1.it)("returns all undefined bars for empty snapshot list", () => {
        const state = (0, iconState_1.buildIconState)([]);
        (0, vitest_1.expect)(state.codex).toBeUndefined();
        (0, vitest_1.expect)(state.claude).toBeUndefined();
        (0, vitest_1.expect)(state.hasError).toBe(false);
    });
    (0, vitest_1.it)("handles both providers active simultaneously", () => {
        const state = (0, iconState_1.buildIconState)([
            snap("codex", "ok", [{ name: "fiveHour", usedPercent: 100 }]),
            snap("claude", "ok", [{ name: "fiveHour", usedPercent: 50 }]),
        ]);
        (0, vitest_1.expect)(state.codex).toEqual({ usedPercent: 100, isStale: false });
        (0, vitest_1.expect)(state.claude).toEqual({ usedPercent: 50, isStale: false });
        (0, vitest_1.expect)(state.hasError).toBe(false);
    });
});
