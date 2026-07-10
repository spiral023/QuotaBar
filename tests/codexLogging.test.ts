import { describe, expect, it, vi, beforeEach } from "vitest";

const mockState = vi.hoisted(() => ({
  payloads: [] as unknown[],
  debug: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../src/auth/codexAuth", () => ({
  resolveCodexCredentials: vi.fn(async () => ({
    state: "ok",
    credentials: {
      accessToken: "token-redacted-by-test",
      accountId: "acct_test",
    },
    path: "/home/test/.codex/auth.json",
  })),
}));

vi.mock("../src/main/httpClient", () => ({
  httpFetch: vi.fn(async () => {
    const payload = mockState.payloads.shift();
    return {
      ok: true,
      status: 200,
      json: async () => payload,
    };
  }),
}));

vi.mock("../src/main/logging", () => ({
  log: {
    debug: mockState.debug,
    info: vi.fn(),
    warn: mockState.warn,
    error: vi.fn(),
  },
}));

import { CodexProvider } from "../src/providers/codex";

describe("CodexProvider logging", () => {
  beforeEach(() => {
    mockState.payloads = [];
    mockState.debug.mockClear();
    mockState.warn.mockClear();
  });

  it("logs the usage payload shape only when it changes", async () => {
    mockState.payloads = [
      { plan_type: "pro", rate_limit: { primary_window: { used_percent: 1 } } },
      { plan_type: "pro", rate_limit: { primary_window: { used_percent: 2 } } },
      { plan_type: "pro", rate_limit: { primary_window: { used_percent: 3 } }, credits: { balance: 10 } },
    ];
    const provider = new CodexProvider();

    await provider.fetchUsage();
    await provider.fetchUsage();
    await provider.fetchUsage();

    expect(mockState.debug).toHaveBeenCalledTimes(2);
    expect(mockState.debug.mock.calls[0][0]).toContain("Codex usage payload shape changed:");
    expect(mockState.debug.mock.calls[1][0]).toContain("Codex usage payload shape changed:");
  });
});
