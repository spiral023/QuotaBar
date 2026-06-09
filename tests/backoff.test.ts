import { describe, expect, it } from "vitest";
import { computeBackoffMs, MIN_RETRY_MS, MAX_RETRY_MS } from "../src/usage/backoff";

describe("computeBackoffMs", () => {
  const noJitter = () => 0;

  it("server retry-after of 0 is raised to MIN_RETRY_MS", () => {
    expect(computeBackoffMs(0, 1, noJitter)).toBe(MIN_RETRY_MS);
  });

  it("uses the larger of server value and MIN_RETRY_MS", () => {
    expect(computeBackoffMs(8_000, 1, noJitter)).toBe(8_000);
    expect(computeBackoffMs(2_000, 1, noJitter)).toBe(MIN_RETRY_MS);
  });

  it("doubles per consecutive rate limit", () => {
    expect(computeBackoffMs(5_000, 1, noJitter)).toBe(5_000);
    expect(computeBackoffMs(5_000, 2, noJitter)).toBe(10_000);
    expect(computeBackoffMs(5_000, 3, noJitter)).toBe(20_000);
  });

  it("is capped at MAX_RETRY_MS", () => {
    expect(computeBackoffMs(5_000, 20, noJitter)).toBe(MAX_RETRY_MS);
  });

  it("adds jitter from the injected random source", () => {
    // random()=0.5 → +1500ms jitter (0.5 * 3000)
    expect(computeBackoffMs(5_000, 1, () => 0.5)).toBe(6_500);
  });
});
