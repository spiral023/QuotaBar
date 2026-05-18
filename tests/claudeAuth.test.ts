import { describe, expect, it } from "vitest";
import { parseClaudeCredentialsJson } from "../src/auth/claudeAuth";

describe("parseClaudeCredentialsJson", () => {
  it("reads Claude Code OAuth credentials", () => {
    const parsed = parseClaudeCredentialsJson(JSON.stringify({
      claudeAiOauth: {
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: 4102444800000,
        scopes: ["user:profile"],
        rateLimitTier: "Max"
      }
    }));

    expect(parsed?.accessToken).toBe("access");
    expect(parsed?.refreshToken).toBe("refresh");
    expect(parsed?.expiresAt?.toISOString()).toBe("2100-01-01T00:00:00.000Z");
    expect(parsed?.rateLimitTier).toBe("Max");
  });

  it("returns null when the OAuth block is missing", () => {
    expect(parseClaudeCredentialsJson("{}")).toBeNull();
  });
});
