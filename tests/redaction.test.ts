import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/shared/redaction";

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
