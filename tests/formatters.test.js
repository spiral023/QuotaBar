"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const formatters_1 = require("../src/usage/formatters");
(0, vitest_1.describe)("formatTimeRemaining", () => {
    (0, vitest_1.it)("formats remaining time compactly", () => {
        vitest_1.vi.setSystemTime(new Date("2026-05-18T10:00:00.000Z"));
        (0, vitest_1.expect)((0, formatters_1.formatTimeRemaining)("2026-05-18T10:00:00.000Z")).toBe("now");
        (0, vitest_1.expect)((0, formatters_1.formatTimeRemaining)("2026-05-18T10:42:00.000Z")).toBe("42m");
        (0, vitest_1.expect)((0, formatters_1.formatTimeRemaining)("2026-05-18T12:15:00.000Z")).toBe("2h15m");
        (0, vitest_1.expect)((0, formatters_1.formatTimeRemaining)("2026-05-19T13:00:00.000Z")).toBe("1d3h");
        vitest_1.vi.useRealTimers();
    });
});
