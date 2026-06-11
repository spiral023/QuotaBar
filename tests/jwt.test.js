"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const jwt_1 = require("../src/auth/jwt");
function jwt(payload) {
    const encoded = Buffer.from(JSON.stringify(payload), "utf8")
        .toString("base64url");
    return `header.${encoded}.signature`;
}
(0, vitest_1.describe)("decodeJwtClaim", () => {
    (0, vitest_1.it)("decodes a base64url JWT claim", () => {
        const token = jwt({ sub: "user-1", "https://api.openai.com/auth.chatgpt_account_id": "acct_123" });
        (0, vitest_1.expect)((0, jwt_1.decodeJwtClaim)(token, "https://api.openai.com/auth.chatgpt_account_id")).toBe("acct_123");
    });
    (0, vitest_1.it)("returns undefined for malformed JWTs", () => {
        (0, vitest_1.expect)((0, jwt_1.decodeJwtClaim)("not-a-jwt", "sub")).toBeUndefined();
    });
});
