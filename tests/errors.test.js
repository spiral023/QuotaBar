"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const errors_1 = require("../src/shared/errors");
(0, vitest_1.describe)("RateLimitError", () => {
    (0, vitest_1.it)("stores retryAfterMs and sets name", () => {
        const err = new errors_1.RateLimitError(300_000);
        (0, vitest_1.expect)(err.retryAfterMs).toBe(300_000);
        (0, vitest_1.expect)(err.name).toBe("RateLimitError");
        (0, vitest_1.expect)(err.message).toContain("300s");
    });
});
(0, vitest_1.describe)("toErrorMessage", () => {
    (0, vitest_1.it)("includes fetch cause codes when available", () => {
        const error = new TypeError("fetch failed", {
            cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.example.test"), { code: "ENOTFOUND" })
        });
        (0, vitest_1.expect)((0, errors_1.toErrorMessage)(error)).toContain("fetch failed (ENOTFOUND: getaddrinfo ENOTFOUND api.example.test)");
    });
});
