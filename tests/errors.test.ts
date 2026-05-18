import { describe, expect, it } from "vitest";
import { RateLimitError, toErrorMessage } from "../src/shared/errors";

describe("RateLimitError", () => {
  it("stores retryAfterMs and sets name", () => {
    const err = new RateLimitError(300_000);
    expect(err.retryAfterMs).toBe(300_000);
    expect(err.name).toBe("RateLimitError");
    expect(err.message).toContain("300s");
  });
});

describe("toErrorMessage", () => {
  it("includes fetch cause codes when available", () => {
    const error = new TypeError("fetch failed", {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.example.test"), { code: "ENOTFOUND" })
    });

    expect(toErrorMessage(error)).toContain("fetch failed (ENOTFOUND: getaddrinfo ENOTFOUND api.example.test)");
  });
});
