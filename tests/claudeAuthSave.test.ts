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

import { ClaudeCredentialsWriteError, saveClaudeCredentials } from "../src/auth/claudeAuth";

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
    await fs.writeFile(mocks.credentialsPath, JSON.stringify({ claudeAiOauth: { accessToken: "old" } }), "utf8");

    await saveClaudeCredentials({
      accessToken: "access",
      refreshToken: "refresh",
      scopes: [],
    });

    expect(JSON.parse(await fs.readFile(mocks.credentialsPath, "utf8")).claudeAiOauth.refreshToken).toBe("refresh");
    expect((await fs.readdir(tmp)).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("keeps unrelated top-level keys owned by Claude Code", async () => {
    await fs.writeFile(mocks.credentialsPath, JSON.stringify({
      claudeAiOauth: { accessToken: "old" },
      mcpOAuth: { server: { accessToken: "mcp" } },
    }), "utf8");

    await saveClaudeCredentials({ accessToken: "new", scopes: [] });

    const parsed = JSON.parse(await fs.readFile(mocks.credentialsPath, "utf8"));
    expect(parsed.mcpOAuth).toEqual({ server: { accessToken: "mcp" } });
    expect(parsed.claudeAiOauth.accessToken).toBe("new");
  });

  it("writes back to the file the credentials were read from", async () => {
    const otherRoot = path.join(tmp, "wsl-root");
    await fs.mkdir(otherRoot);
    const sourcePath = path.join(otherRoot, ".credentials.json");
    await fs.writeFile(sourcePath, JSON.stringify({ claudeAiOauth: { accessToken: "old" } }), "utf8");

    await saveClaudeCredentials({ accessToken: "new", scopes: [], sourcePath });

    expect(JSON.parse(await fs.readFile(sourcePath, "utf8")).claudeAiOauth).toEqual({ accessToken: "new", scopes: [] });
    await expect(fs.access(mocks.credentialsPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to rewrite a file it cannot parse", async () => {
    await fs.writeFile(mocks.credentialsPath, "{ half-written", "utf8");

    await expect(saveClaudeCredentials({ accessToken: "new", scopes: [] }))
      .rejects.toBeInstanceOf(ClaudeCredentialsWriteError);

    expect(await fs.readFile(mocks.credentialsPath, "utf8")).toBe("{ half-written");
  });

  it("does not recreate a credentials file that disappeared", async () => {
    await expect(saveClaudeCredentials({ accessToken: "new", scopes: [] }))
      .rejects.toThrow("disappeared");

    await expect(fs.access(mocks.credentialsPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never puts tokens or paths into its error messages", async () => {
    await fs.writeFile(mocks.credentialsPath, "[\"secret-token\"]", "utf8");

    const error = await saveClaudeCredentials({ accessToken: "secret-new", scopes: [] }).catch((caught: unknown) => caught);

    expect(String(error)).not.toContain("secret");
    expect(String(error)).not.toContain(tmp);
  });
});
