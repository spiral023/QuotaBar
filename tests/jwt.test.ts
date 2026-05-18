import { describe, expect, it } from "vitest";
import { decodeJwtClaim } from "../src/auth/jwt";

function jwt(payload: object): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8")
    .toString("base64url");
  return `header.${encoded}.signature`;
}

describe("decodeJwtClaim", () => {
  it("decodes a base64url JWT claim", () => {
    const token = jwt({ sub: "user-1", "https://api.openai.com/auth.chatgpt_account_id": "acct_123" });

    expect(decodeJwtClaim(token, "https://api.openai.com/auth.chatgpt_account_id")).toBe("acct_123");
  });

  it("returns undefined for malformed JWTs", () => {
    expect(decodeJwtClaim("not-a-jwt", "sub")).toBeUndefined();
  });
});
