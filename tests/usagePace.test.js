"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const usagePace_1 = require("../src/usage/usagePace");
const SEVEN_DAYS_S = 7 * 24 * 3600;
const NOW = new Date("2026-01-01T00:00:00.000Z");
function makeWindow(elapsedFraction, usedPercent, windowMinutes = 10080) {
    const duration = windowMinutes * 60;
    const elapsed = duration * elapsedFraction;
    const timeUntilReset = duration - elapsed;
    const resetsAt = new Date(NOW.getTime() + timeUntilReset * 1000);
    return { usedPercent, windowMinutes, resetsAt };
}
(0, vitest_1.describe)("computeLinearPace", () => {
    (0, vitest_1.it)("onTrack: elapsed=50%, actual=50% → delta≈0, willLastToReset=true", () => {
        const result = (0, usagePace_1.computeLinearPace)(makeWindow(0.5, 50), NOW);
        (0, vitest_1.expect)(result).not.toBeNull();
        (0, vitest_1.expect)(result.stage).toBe("onTrack");
        (0, vitest_1.expect)(result.deltaPercent).toBeCloseTo(0, 1);
        (0, vitest_1.expect)(result.willLastToReset).toBe(true);
        (0, vitest_1.expect)(result.etaSeconds).toBeNull();
    });
    (0, vitest_1.it)("farAhead: elapsed=30%, actual=45% → delta=+15, stage=farAhead", () => {
        const result = (0, usagePace_1.computeLinearPace)(makeWindow(0.3, 45), NOW);
        (0, vitest_1.expect)(result).not.toBeNull();
        (0, vitest_1.expect)(result.stage).toBe("farAhead");
        (0, vitest_1.expect)(result.deltaPercent).toBeCloseTo(15, 1);
    });
    (0, vitest_1.it)("high burn: elapsed=50%, actual=80% → etaSeconds gesetzt, willLastToReset=false", () => {
        const result = (0, usagePace_1.computeLinearPace)(makeWindow(0.5, 80), NOW);
        (0, vitest_1.expect)(result).not.toBeNull();
        (0, vitest_1.expect)(result.etaSeconds).not.toBeNull();
        (0, vitest_1.expect)(result.willLastToReset).toBe(false);
        // candidate = (20 / (80/302400)) ≈ 75600s ≈ 21h
        (0, vitest_1.expect)(result.etaSeconds).toBeCloseTo(75600, -2);
    });
    (0, vitest_1.it)("null wenn resetsAt=null", () => {
        const w = { usedPercent: 50, windowMinutes: 10080, resetsAt: null };
        (0, vitest_1.expect)((0, usagePace_1.computeLinearPace)(w, NOW)).toBeNull();
    });
    (0, vitest_1.it)("elapsed>0, actual=0 → willLastToReset=true, kein ETA", () => {
        const result = (0, usagePace_1.computeLinearPace)(makeWindow(0.5, 0), NOW);
        (0, vitest_1.expect)(result).not.toBeNull();
        (0, vitest_1.expect)(result.willLastToReset).toBe(true);
        (0, vitest_1.expect)(result.etaSeconds).toBeNull();
    });
    (0, vitest_1.it)("elapsed=0, actual>0 → null (ungültiger Zustand)", () => {
        // resetsAt genau duration von jetzt → elapsed=0
        const resetsAt = new Date(NOW.getTime() + SEVEN_DAYS_S * 1000);
        const w = { usedPercent: 10, windowMinutes: 10080, resetsAt };
        (0, vitest_1.expect)((0, usagePace_1.computeLinearPace)(w, NOW)).toBeNull();
    });
    (0, vitest_1.it)("timeUntilReset > duration → null", () => {
        const resetsAt = new Date(NOW.getTime() + (SEVEN_DAYS_S + 1) * 1000);
        const w = { usedPercent: 50, windowMinutes: 10080, resetsAt };
        (0, vitest_1.expect)((0, usagePace_1.computeLinearPace)(w, NOW)).toBeNull();
    });
});
const GAP_NOW = new Date("2026-01-01T12:00:00.000Z");
function gapResetsAt(offsetSeconds) {
    return new Date(GAP_NOW.getTime() + offsetSeconds * 1000).toISOString();
}
function makePace(overrides) {
    return {
        stage: "onTrack",
        deltaPercent: 0,
        expectedUsedPercent: 50,
        actualUsedPercent: 50,
        etaSeconds: null,
        willLastToReset: true,
        ...overrides,
    };
}
(0, vitest_1.describe)("computeSafetyGap", () => {
    (0, vitest_1.it)("willLastToReset=true → returns timeToReset (safe, large positive)", () => {
        const resetsAt = gapResetsAt(3600);
        const pace = makePace({ willLastToReset: true, etaSeconds: null });
        (0, vitest_1.expect)((0, usagePace_1.computeSafetyGap)(resetsAt, pace, GAP_NOW)).toBeCloseTo(3600, 0);
    });
    (0, vitest_1.it)("etaSeconds < timeToReset → positive gap (blocking duration = timeToReset - etaSeconds)", () => {
        const resetsAt = gapResetsAt(3600);
        const pace = makePace({ willLastToReset: false, etaSeconds: 1800 });
        (0, vitest_1.expect)((0, usagePace_1.computeSafetyGap)(resetsAt, pace, GAP_NOW)).toBeCloseTo(1800, 0);
    });
    (0, vitest_1.it)("small etaSeconds → small gap (almost no time until limit)", () => {
        const resetsAt = gapResetsAt(3600);
        const pace = makePace({ willLastToReset: false, etaSeconds: 600 });
        (0, vitest_1.expect)((0, usagePace_1.computeSafetyGap)(resetsAt, pace, GAP_NOW)).toBeCloseTo(3000, 0);
    });
    (0, vitest_1.it)("past reset → null", () => {
        const resetsAt = gapResetsAt(-1);
        const pace = makePace({ willLastToReset: false, etaSeconds: 600 });
        (0, vitest_1.expect)((0, usagePace_1.computeSafetyGap)(resetsAt, pace, GAP_NOW)).toBeNull();
    });
    (0, vitest_1.it)("etaSeconds=null and willLastToReset=false → null (no data)", () => {
        const resetsAt = gapResetsAt(3600);
        const pace = makePace({ willLastToReset: false, etaSeconds: null });
        (0, vitest_1.expect)((0, usagePace_1.computeSafetyGap)(resetsAt, pace, GAP_NOW)).toBeNull();
    });
});
