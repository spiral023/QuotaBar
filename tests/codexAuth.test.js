"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const codexAuth_1 = require("../src/auth/codexAuth");
(0, vitest_1.describe)("parseCodexAuthJson", () => {
    (0, vitest_1.it)("reads nested Codex CLI access tokens", () => {
        const parsed = (0, codexAuth_1.parseCodexAuthJson)(JSON.stringify({ tokens: { access_token: "tok_nested" } }));
        (0, vitest_1.expect)(parsed?.accessToken).toBe("tok_nested");
    });
    (0, vitest_1.it)("reads root access tokens and extracts account id from JWT", () => {
        const payload = Buffer.from(JSON.stringify({
            "https://api.openai.com/auth.chatgpt_account_id": "acct_root"
        })).toString("base64url");
        const parsed = (0, codexAuth_1.parseCodexAuthJson)(JSON.stringify({ access_token: `h.${payload}.s` }));
        (0, vitest_1.expect)(parsed?.accessToken).toContain(".");
        (0, vitest_1.expect)(parsed?.accountId).toBe("acct_root");
    });
});
