import { describe, expect, it } from "vitest";
import { redactPII, redactSecrets } from "../src/shared/redaction";

describe("redactSecrets", () => {
  it("redacts bearer tokens, JWTs, cookies, and JSON token fields", () => {
    const input = [
      "Authorization: Bearer abc.def.ghi",
      "Cookie: session_id=secret; other=value",
      "\"access_token\":\"sk-secret\"",
      "refresh_token=raw-refresh"
    ].join("\n");

    const redacted = redactSecrets(input);

    expect(redacted).not.toContain("abc.def.ghi");
    expect(redacted).not.toContain("session_id=secret");
    expect(redacted).not.toContain("sk-secret");
    expect(redacted).not.toContain("raw-refresh");
    expect(redacted).toContain("[REDACTED]");
  });
});

describe("redactPII", () => {
  it("redacts email field", () => {
    expect(redactPII({ email: "phil@example.com", x: 1 })).toEqual({ email: "<redacted>", x: 1 });
  });

  it("redacts account_id, accountId, user_id, userId", () => {
    const out = redactPII({ account_id: "a", accountId: "b", user_id: "c", userId: "d", keep: "e" });
    expect(out).toEqual({ account_id: "<redacted>", accountId: "<redacted>", user_id: "<redacted>", userId: "<redacted>", keep: "e" });
  });

  it("walks nested objects and arrays", () => {
    const out = redactPII({
      provider: "codex",
      identity: { accountId: "abc", email: "x@y.com" },
      sessions: [{ userId: "u1" }, { userId: "u2", model: "gpt-5" }],
    });
    expect(out).toEqual({
      provider: "codex",
      identity: { accountId: "<redacted>", email: "<redacted>" },
      sessions: [{ userId: "<redacted>" }, { userId: "<redacted>", model: "gpt-5" }],
    });
  });

  it("does not mutate the input", () => {
    const input = { email: "x@y.com", n: 1 };
    redactPII(input);
    expect(input).toEqual({ email: "x@y.com", n: 1 });
  });

  it("returns primitives unchanged", () => {
    expect(redactPII(42)).toBe(42);
    expect(redactPII("hi")).toBe("hi");
    expect(redactPII(null)).toBe(null);
  });
});
