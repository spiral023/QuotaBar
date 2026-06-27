import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  credentialsPath: "",
}));

vi.mock("../src/config/paths", () => ({
  getClaudeCredentialsPath: () => mocks.credentialsPath,
}));

import { saveClaudeCredentials } from "../src/auth/claudeAuth";

describe("saveClaudeCredentials", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "qb-claude-auth-"));
    mocks.credentialsPath = path.join(tmp, ".credentials.json");
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("preserves existing optional fields when the update omits them", async () => {
    await fs.writeFile(mocks.credentialsPath, JSON.stringify({
      claudeAiOauth: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: 4102444800000,
        scopes: ["old"],
        rateLimitTier: "Max",
      },
    }), "utf8");

    await saveClaudeCredentials({
      accessToken: "new-access",
      scopes: ["user:profile"],
    });

    const parsed = JSON.parse(await fs.readFile(mocks.credentialsPath, "utf8"));
    expect(parsed.claudeAiOauth).toMatchObject({
      accessToken: "new-access",
      refreshToken: "old-refresh",
      scopes: ["user:profile"],
      rateLimitTier: "Max",
    });
  });

  it("writes through a temp file and leaves no stale temp file behind", async () => {
    await saveClaudeCredentials({
      accessToken: "access",
      refreshToken: "refresh",
      scopes: [],
    });

    expect(JSON.parse(await fs.readFile(mocks.credentialsPath, "utf8")).claudeAiOauth.refreshToken).toBe("refresh");
    expect((await fs.readdir(tmp)).filter((name) => name.includes(".tmp"))).toEqual([]);
  });
});
