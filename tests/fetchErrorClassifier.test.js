"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const fetchErrorClassifier_1 = require("../src/usage/fetchErrorClassifier");
function withCause(code) {
    const err = new Error("fetch failed");
    err.cause = Object.assign(new Error(code), { code });
    return err;
}
(0, vitest_1.describe)("classifyFetchError", () => {
    (0, vitest_1.it)("classifies DNS failures", () => {
        (0, vitest_1.expect)((0, fetchErrorClassifier_1.classifyFetchError)(withCause("ENOTFOUND"))).toEqual({ kind: "dns", code: "ENOTFOUND" });
        (0, vitest_1.expect)((0, fetchErrorClassifier_1.classifyFetchError)(withCause("EAI_AGAIN"))).toEqual({ kind: "dns", code: "EAI_AGAIN" });
    });
    (0, vitest_1.it)("classifies network failures", () => {
        (0, vitest_1.expect)((0, fetchErrorClassifier_1.classifyFetchError)(withCause("ECONNREFUSED"))).toEqual({ kind: "network", code: "ECONNREFUSED" });
        (0, vitest_1.expect)((0, fetchErrorClassifier_1.classifyFetchError)(withCause("ENETUNREACH"))).toEqual({ kind: "network", code: "ENETUNREACH" });
        (0, vitest_1.expect)((0, fetchErrorClassifier_1.classifyFetchError)(withCause("ECONNRESET"))).toEqual({ kind: "network", code: "ECONNRESET" });
        (0, vitest_1.expect)((0, fetchErrorClassifier_1.classifyFetchError)(withCause("ETIMEDOUT"))).toEqual({ kind: "network", code: "ETIMEDOUT" });
    });
    (0, vitest_1.it)("treats a timeout message as network", () => {
        (0, vitest_1.expect)((0, fetchErrorClassifier_1.classifyFetchError)(new Error("Claude timed out"))).toEqual({ kind: "network", code: "TIMEOUT" });
    });
    (0, vitest_1.it)("returns other for unrelated errors", () => {
        (0, vitest_1.expect)((0, fetchErrorClassifier_1.classifyFetchError)(new Error("HTTP 500"))).toEqual({ kind: "other", code: "" });
    });
});
