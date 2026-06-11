"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const colors_1 = require("../src/icon/colors");
(0, vitest_1.describe)("usage colors", () => {
    (0, vitest_1.it)("maps usage percent to status buckets", () => {
        (0, vitest_1.expect)((0, colors_1.getUsageColor)(49.9)).toBe("green");
        (0, vitest_1.expect)((0, colors_1.getUsageColor)(50)).toBe("yellow");
        (0, vitest_1.expect)((0, colors_1.getUsageColor)(75)).toBe("orange");
        (0, vitest_1.expect)((0, colors_1.getUsageColor)(90)).toBe("red");
    });
    (0, vitest_1.it)("uses the requested Windows tray color values", () => {
        (0, vitest_1.expect)((0, colors_1.getUsageColorHex)("green")).toBe("#52d017");
        (0, vitest_1.expect)((0, colors_1.getUsageColorHex)("yellow")).toBe("#ffd700");
        (0, vitest_1.expect)((0, colors_1.getUsageColorHex)("orange")).toBe("#ff8c00");
        (0, vitest_1.expect)((0, colors_1.getUsageColorHex)("red")).toBe("#ff4444");
    });
});
