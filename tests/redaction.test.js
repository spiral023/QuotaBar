"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const redaction_1 = require("../src/shared/redaction");
(0, vitest_1.describe)("redactSecrets", () => {
    (0, vitest_1.it)("redacts bearer tokens, JWTs, cookies, and JSON token fields", () => {
        const input = [
            "Authorization: Bearer abc.def.ghi",
            "Cookie: session_id=secret; other=value",
            "\"access_token\":\"sk-secret\"",
            "refresh_token=raw-refresh"
        ].join("\n");
        const redacted = (0, redaction_1.redactSecrets)(input);
        (0, vitest_1.expect)(redacted).not.toContain("abc.def.ghi");
        (0, vitest_1.expect)(redacted).not.toContain("session_id=secret");
        (0, vitest_1.expect)(redacted).not.toContain("sk-secret");
        (0, vitest_1.expect)(redacted).not.toContain("raw-refresh");
        (0, vitest_1.expect)(redacted).toContain("[REDACTED]");
    });
});
(0, vitest_1.describe)("redactPII", () => {
    (0, vitest_1.it)("redacts email field", () => {
        (0, vitest_1.expect)((0, redaction_1.redactPII)({ email: "phil@example.com", x: 1 })).toEqual({ email: "<redacted>", x: 1 });
    });
    (0, vitest_1.it)("redacts account_id, accountId, user_id, userId", () => {
        const out = (0, redaction_1.redactPII)({ account_id: "a", accountId: "b", user_id: "c", userId: "d", keep: "e" });
        (0, vitest_1.expect)(out).toEqual({ account_id: "<redacted>", accountId: "<redacted>", user_id: "<redacted>", userId: "<redacted>", keep: "e" });
    });
    (0, vitest_1.it)("walks nested objects and arrays", () => {
        const out = (0, redaction_1.redactPII)({
            provider: "codex",
            identity: { accountId: "abc", email: "x@y.com" },
            sessions: [{ userId: "u1" }, { userId: "u2", model: "gpt-5" }],
        });
        (0, vitest_1.expect)(out).toEqual({
            provider: "codex",
            identity: { accountId: "<redacted>", email: "<redacted>" },
            sessions: [{ userId: "<redacted>" }, { userId: "<redacted>", model: "gpt-5" }],
        });
    });
    (0, vitest_1.it)("does not mutate the input", () => {
        const input = { email: "x@y.com", n: 1 };
        (0, redaction_1.redactPII)(input);
        (0, vitest_1.expect)(input).toEqual({ email: "x@y.com", n: 1 });
    });
    (0, vitest_1.it)("returns primitives unchanged", () => {
        (0, vitest_1.expect)((0, redaction_1.redactPII)(42)).toBe(42);
        (0, vitest_1.expect)((0, redaction_1.redactPII)("hi")).toBe("hi");
        (0, vitest_1.expect)((0, redaction_1.redactPII)(null)).toBe(null);
    });
});
