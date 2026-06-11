"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const backoff_1 = require("../src/usage/backoff");
(0, vitest_1.describe)("computeBackoffMs", () => {
    const noJitter = () => 0;
    (0, vitest_1.it)("server retry-after of 0 is raised to MIN_RETRY_MS", () => {
        (0, vitest_1.expect)((0, backoff_1.computeBackoffMs)(0, 1, noJitter)).toBe(backoff_1.MIN_RETRY_MS);
    });
    (0, vitest_1.it)("uses the larger of server value and MIN_RETRY_MS", () => {
        (0, vitest_1.expect)((0, backoff_1.computeBackoffMs)(8_000, 1, noJitter)).toBe(8_000);
        (0, vitest_1.expect)((0, backoff_1.computeBackoffMs)(2_000, 1, noJitter)).toBe(backoff_1.MIN_RETRY_MS);
    });
    (0, vitest_1.it)("doubles per consecutive rate limit", () => {
        (0, vitest_1.expect)((0, backoff_1.computeBackoffMs)(5_000, 1, noJitter)).toBe(5_000);
        (0, vitest_1.expect)((0, backoff_1.computeBackoffMs)(5_000, 2, noJitter)).toBe(10_000);
        (0, vitest_1.expect)((0, backoff_1.computeBackoffMs)(5_000, 3, noJitter)).toBe(20_000);
    });
    (0, vitest_1.it)("is capped at MAX_RETRY_MS", () => {
        (0, vitest_1.expect)((0, backoff_1.computeBackoffMs)(5_000, 20, noJitter)).toBe(backoff_1.MAX_RETRY_MS);
    });
    (0, vitest_1.it)("adds jitter from the injected random source", () => {
        // random()=0.5 → +1500ms jitter (0.5 * 3000)
        (0, vitest_1.expect)((0, backoff_1.computeBackoffMs)(5_000, 1, () => 0.5)).toBe(6_500);
    });
});
