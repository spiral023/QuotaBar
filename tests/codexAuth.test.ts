import { describe, expect, it } from "vitest";
import { parseCodexAuthJson } from "../src/auth/codexAuth";

describe("parseCodexAuthJson", () => {
  it("reads nested Codex CLI access tokens", () => {
    const parsed = parseCodexAuthJson(JSON.stringify({ tokens: { access_token: "tok_nested" } }));

    expect(parsed?.accessToken).toBe("tok_nested");
  });

  it("reads root access tokens and extracts account id from JWT", () => {
    const payload = Buffer.from(JSON.stringify({
      "https://api.openai.com/auth.chatgpt_account_id": "acct_root"
    })).toString("base64url");

    const parsed = parseCodexAuthJson(JSON.stringify({ access_token: `h.${payload}.s` }));

    expect(parsed?.accessToken).toContain(".");
    expect(parsed?.accountId).toBe("acct_root");
  });

  it("extracts email from id_token nested under tokens", () => {
    const idToken = "x." + Buffer.from(JSON.stringify({ email: "dev@example.com" })).toString("base64url") + ".y";
    const parsed = parseCodexAuthJson(JSON.stringify({ tokens: { access_token: "tok", id_token: idToken } }));

    expect(parsed?.email).toBe("dev@example.com");
  });

  it("leaves email undefined when id_token is absent", () => {
    const parsed = parseCodexAuthJson(JSON.stringify({ tokens: { access_token: "tok" } }));

    expect(parsed?.email).toBeUndefined();
  });

  it("leaves email undefined and does not throw when id_token is not a valid JWT", () => {
    const parsed = parseCodexAuthJson(JSON.stringify({ tokens: { access_token: "tok", id_token: "garbage" } }));

    expect(parsed?.email).toBeUndefined();
  });
});
