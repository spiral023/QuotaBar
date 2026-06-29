import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearClaudeProfileCache, fetchClaudeProfile } from "../src/auth/claudeProfile";

function makeFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body)
  });
}

beforeEach(() => {
  clearClaudeProfileCache();
  vi.restoreAllMocks();
});

describe("fetchClaudeProfile", () => {
  it("success maps all four fields", async () => {
    const body = {
      account: { uuid: "uuid-1", email: "user@example.com", display_name: "User One" },
      organization: { name: "Acme Corp" }
    };
    vi.stubGlobal("fetch", makeFetch(200, body));

    const result = await fetchClaudeProfile("tok-abc", 5000);

    expect(result).toEqual({
      email: "user@example.com",
      accountUuid: "uuid-1",
      displayName: "User One",
      organizationName: "Acme Corp"
    });
  });

  it("HTTP 500 returns null", async () => {
    vi.stubGlobal("fetch", makeFetch(500, {}));

    const result = await fetchClaudeProfile("tok-abc", 5000);

    expect(result).toBeNull();
  });

  it("thrown fetch error returns null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

    const result = await fetchClaudeProfile("tok-abc", 5000);

    expect(result).toBeNull();
  });

  it("second call with same token uses cache (fetch called once)", async () => {
    const body = {
      account: { uuid: "uuid-2", email: "a@b.com", display_name: "A B" },
      organization: { name: "Org" }
    };
    const mockFetch = makeFetch(200, body);
    vi.stubGlobal("fetch", mockFetch);

    await fetchClaudeProfile("tok-same", 5000);
    await fetchClaudeProfile("tok-same", 5000);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("call with a different token fetches again", async () => {
    const mockFetch = makeFetch(200, {
      account: { uuid: "u", email: "x@y.com", display_name: "X" },
      organization: { name: "O" }
    });
    vi.stubGlobal("fetch", mockFetch);

    await fetchClaudeProfile("tok-first", 5000);
    await fetchClaudeProfile("tok-second", 5000);

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("failed (null) result is also cached: two calls same token after a 500 fetch only once", async () => {
    const mockFetch = makeFetch(500, {});
    vi.stubGlobal("fetch", mockFetch);

    const r1 = await fetchClaudeProfile("tok-fail", 5000);
    const r2 = await fetchClaudeProfile("tok-fail", 5000);

    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
