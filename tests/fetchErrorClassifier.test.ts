import { describe, expect, it } from "vitest";
import { classifyFetchError } from "../src/usage/fetchErrorClassifier";

function withCause(code: string): Error {
  const err = new Error("fetch failed");
  (err as Error & { cause?: unknown }).cause = Object.assign(new Error(code), { code });
  return err;
}

describe("classifyFetchError", () => {
  it("classifies DNS failures", () => {
    expect(classifyFetchError(withCause("ENOTFOUND"))).toEqual({ kind: "dns", code: "ENOTFOUND" });
    expect(classifyFetchError(withCause("EAI_AGAIN"))).toEqual({ kind: "dns", code: "EAI_AGAIN" });
  });

  it("classifies network failures", () => {
    expect(classifyFetchError(withCause("ECONNREFUSED"))).toEqual({ kind: "network", code: "ECONNREFUSED" });
    expect(classifyFetchError(withCause("ENETUNREACH"))).toEqual({ kind: "network", code: "ENETUNREACH" });
    expect(classifyFetchError(withCause("ECONNRESET"))).toEqual({ kind: "network", code: "ECONNRESET" });
    expect(classifyFetchError(withCause("ETIMEDOUT"))).toEqual({ kind: "network", code: "ETIMEDOUT" });
  });

  it("treats a timeout message as network", () => {
    expect(classifyFetchError(new Error("Claude timed out"))).toEqual({ kind: "network", code: "TIMEOUT" });
  });

  it("returns other for unrelated errors", () => {
    expect(classifyFetchError(new Error("HTTP 500"))).toEqual({ kind: "other", code: "" });
  });
});
