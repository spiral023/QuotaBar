import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), warn: vi.fn() }));

vi.mock("../src/main/httpClient", async (importOriginal) => ({
  requestSignal: (await importOriginal<typeof import("../src/main/httpClient")>()).requestSignal,
  httpFetch: mocks.fetch,
}));
vi.mock("../src/main/logging", () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: mocks.warn, error: vi.fn() } }));
vi.mock("../src/auth/codexAuth", () => ({
  resolveCodexCredentials: vi.fn(async () => ({
    state: "ok",
    credentials: { accessToken: "token-redacted-by-test", accountId: "acct_test" },
  })),
}));
vi.mock("../src/auth/claudeAuth", () => ({
  loadClaudeCredentials: vi.fn(async () => ({ accessToken: "token-redacted-by-test", scopes: [] })),
  isClaudeTokenExpired: () => false,
}));

import { ClaudeProvider } from "../src/providers/claude";
import { CodexProvider } from "../src/providers/codex";

function fetchFailed(code: string): Error {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
}

describe("provider error snapshots carry the transport failure class", () => {
  beforeEach(() => {
    mocks.fetch.mockReset();
    mocks.warn.mockReset();
  });

  it.each([
    ["Claude", () => new ClaudeProvider()],
    ["Codex", () => new CodexProvider()],
  ])("%s marks DNS failures", async (_name, create) => {
    mocks.fetch.mockRejectedValue(fetchFailed("ENOTFOUND"));

    const snapshot = await create().fetchUsage();

    expect(snapshot).toMatchObject({ status: "error", errorKind: "dns", errorCode: "ENOTFOUND" });
  });

  it.each([
    ["Claude", () => new ClaudeProvider()],
    ["Codex", () => new CodexProvider()],
  ])("%s marks connection failures", async (_name, create) => {
    mocks.fetch.mockRejectedValue(fetchFailed("ECONNRESET"));

    expect(await create().fetchUsage()).toMatchObject({ errorKind: "network", errorCode: "ECONNRESET" });
  });

  it("leaves HTTP errors unclassified because the server was reached", async () => {
    mocks.fetch.mockResolvedValue(new Response("", { status: 500 }));

    const snapshot = await new CodexProvider().fetchUsage();

    expect(snapshot.status).toBe("error");
    expect(snapshot.errorKind).toBeUndefined();
  });

  it("stays quiet when the refresh cycle already gave up on the request", async () => {
    const controller = new AbortController();
    mocks.fetch.mockImplementation(async () => {
      controller.abort(new Error("cycle timed out"));
      throw new DOMException("This operation was aborted", "AbortError");
    });

    await new CodexProvider().fetchUsage(controller.signal);

    expect(mocks.warn).not.toHaveBeenCalled();
  });
});
