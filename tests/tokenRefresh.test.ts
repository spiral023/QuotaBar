import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeCredentials } from "../src/auth/claudeAuth";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), save: vi.fn() }));
vi.mock("../src/main/httpClient", () => ({ httpFetch: mocks.fetch }));
vi.mock("../src/auth/claudeAuth", () => ({ saveClaudeCredentials: mocks.save }));
import { refreshClaudeToken } from "../src/auth/tokenRefresh";

const credentials: ClaudeCredentials = { accessToken: "synthetic-old", refreshToken: "synthetic-refresh", scopes: ["usage"] };
beforeEach(() => { vi.clearAllMocks(); mocks.save.mockResolvedValue(undefined); });
afterEach(() => { vi.restoreAllMocks(); });

describe("Claude token refresh boundary", () => {
  it("persists rotated credentials while retaining account metadata", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1000000);
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ access_token: "synthetic-new", refresh_token: "synthetic-rotated", expires_in: 3600 })));
    const result = await refreshClaudeToken(credentials);
    expect(result.scopes).toEqual(credentials.scopes);
    expect(result.expiresAt?.getTime()).toBe(4600000);
    expect(result.accessToken === credentials.accessToken).toBe(false);
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith(result);
  });

  it("retains the previous refresh credential when the provider omits rotation", async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ access_token: "synthetic-new", expires_in: 60 })));
    expect((await refreshClaudeToken(credentials)).refreshToken === credentials.refreshToken).toBe(true);
  });

  it("rejects missing refresh credentials before network or persistence", async () => {
    await expect(refreshClaudeToken({ ...credentials, refreshToken: undefined })).rejects.toThrow("refresh token missing");
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("reports only the HTTP status and never persists a rejected response", async () => {
    mocks.fetch.mockResolvedValue(new Response("synthetic provider details", { status: 401 }));
    await expect(refreshClaudeToken(credentials)).rejects.toThrow("HTTP 401");
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("rejects unknown payloads and network failures without saving", async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ expires_in: "invalid" })));
    await expect(refreshClaudeToken(credentials)).rejects.toThrow("unknown payload");
    mocks.fetch.mockRejectedValueOnce(new Error("Synthetic network failure"));
    await expect(refreshClaudeToken(credentials)).rejects.toThrow("Synthetic network failure");
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
