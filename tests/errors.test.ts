import { describe, expect, it } from "vitest";
import { toErrorMessage } from "../src/shared/errors";

describe("toErrorMessage", () => {
  it("includes fetch cause codes when available", () => {
    const error = new TypeError("fetch failed", {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.example.test"), { code: "ENOTFOUND" })
    });

    expect(toErrorMessage(error)).toContain("fetch failed (ENOTFOUND: getaddrinfo ENOTFOUND api.example.test)");
  });
});
