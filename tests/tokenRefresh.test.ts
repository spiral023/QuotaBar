import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeCredentials } from "../src/auth/claudeAuth";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), save: vi.fn(), read: vi.fn() }));
vi.mock("../src/main/httpClient", () => ({ httpFetch: mocks.fetch }));
vi.mock("../src/auth/claudeAuth", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/auth/claudeAuth")>(),
  saveClaudeCredentials: mocks.save,
  readClaudeCredentialsFile: mocks.read,
}));
import { refreshClaudeToken } from "../src/auth/tokenRefresh";

const credentials: ClaudeCredentials = { accessToken: "synthetic-old", refreshToken: "synthetic-refresh", scopes: ["usage"] };
const fileCredentials: ClaudeCredentials = { ...credentials, sourcePath: "C:/synthetic/.credentials.json" };

function tokenResponse(accessToken = "synthetic-new"): Response {
  return new Response(JSON.stringify({ access_token: accessToken, refresh_token: "synthetic-rotated", expires_in: 3600 }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.save.mockResolvedValue(undefined);
  mocks.read.mockResolvedValue(fileCredentials);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("Claude token refresh boundary", () => {
  it("persists rotated credentials while retaining account metadata", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1000000);
    mocks.fetch.mockResolvedValue(tokenResponse());
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

  it("shares one refresh between concurrent callers for the same file", async () => {
    let respond!: (response: Response) => void;
    mocks.fetch.mockReturnValue(new Promise<Response>((resolve) => { respond = resolve; }));

    const first = refreshClaudeToken(fileCredentials);
    const second = refreshClaudeToken({ ...fileCredentials, sourcePath: "c:/SYNTHETIC/.credentials.json" });
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    respond(tokenResponse());

    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.save).toHaveBeenCalledOnce();

    mocks.fetch.mockResolvedValue(tokenResponse("synthetic-later"));
    expect((await refreshClaudeToken(fileCredentials)).accessToken).toBe("synthetic-later");
  });

  it("uses a newer valid token from the file instead of spending the refresh token again", async () => {
    const newer = { ...fileCredentials, accessToken: "synthetic-from-claude-code", expiresAt: new Date(Date.now() + 3_600_000) };
    mocks.read.mockResolvedValue(newer);

    expect(await refreshClaudeToken(fileCredentials)).toBe(newer);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("refreshes with the file's current refresh token", async () => {
    mocks.read.mockResolvedValue({ ...fileCredentials, refreshToken: "synthetic-current-refresh" });
    mocks.fetch.mockResolvedValue(tokenResponse());

    await refreshClaudeToken(fileCredentials);

    const body = mocks.fetch.mock.calls[0][1].body as URLSearchParams;
    expect(body.get("refresh_token")).toBe("synthetic-current-refresh");
  });

  it("does not refresh when the file cannot be re-read", async () => {
    mocks.read.mockRejectedValue(Object.assign(new Error("EBUSY: C:/Users/someone/.credentials.json"), { code: "EBUSY" }));

    const error = await refreshClaudeToken(fileCredentials).catch((caught: unknown) => caught);

    expect(String(error)).toContain("could not be re-read before refresh (EBUSY)");
    expect(String(error)).not.toContain("someone");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("reports a logged-out file as not authenticated", async () => {
    mocks.read.mockResolvedValue(null);
    await expect(refreshClaudeToken(fileCredentials)).rejects.toMatchObject({ name: "NotAuthenticatedError" });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("does not start a refresh for an already cancelled cycle", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cycle timed out"));

    await expect(refreshClaudeToken(fileCredentials, 10_000, { signal: controller.signal })).rejects.toThrow("cycle timed out");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("does not abort a started token request with the cycle signal", async () => {
    const controller = new AbortController();
    mocks.fetch.mockImplementation(async (_url: string, init: RequestInit) => {
      controller.abort(new Error("cycle timed out"));
      expect(init.signal?.aborted).toBe(false);
      return tokenResponse();
    });

    await expect(refreshClaudeToken(fileCredentials, 10_000, { signal: controller.signal })).resolves.toMatchObject({
      accessToken: "synthetic-new",
    });
    expect(mocks.save).toHaveBeenCalledOnce();
  });
});
