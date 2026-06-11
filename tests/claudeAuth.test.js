"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const claudeAuth_1 = require("../src/auth/claudeAuth");
(0, vitest_1.describe)("parseClaudeCredentialsJson", () => {
    (0, vitest_1.it)("reads Claude Code OAuth credentials", () => {
        const parsed = (0, claudeAuth_1.parseClaudeCredentialsJson)(JSON.stringify({
            claudeAiOauth: {
                accessToken: "access",
                refreshToken: "refresh",
                expiresAt: 4102444800000,
                scopes: ["user:profile"],
                rateLimitTier: "Max"
            }
        }));
        (0, vitest_1.expect)(parsed?.accessToken).toBe("access");
        (0, vitest_1.expect)(parsed?.refreshToken).toBe("refresh");
        (0, vitest_1.expect)(parsed?.expiresAt?.toISOString()).toBe("2100-01-01T00:00:00.000Z");
        (0, vitest_1.expect)(parsed?.rateLimitTier).toBe("Max");
    });
    (0, vitest_1.it)("returns null when the OAuth block is missing", () => {
        (0, vitest_1.expect)((0, claudeAuth_1.parseClaudeCredentialsJson)("{}")).toBeNull();
    });
});
