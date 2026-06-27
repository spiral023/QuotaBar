import { describe, expect, it } from "vitest";
import { parseRetryAfterMs } from "../src/providers/claude";

describe("parseRetryAfterMs", () => {
  it("parses delta-seconds Retry-After values", () => {
    expect(parseRetryAfterMs("120", new Date("2026-06-01T00:00:00.000Z"))).toBe(120_000);
  });

  it("parses HTTP-date Retry-After values", () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    expect(parseRetryAfterMs("Mon, 01 Jun 2026 00:05:00 GMT", now)).toBe(300_000);
  });

  it("falls back for invalid or past values", () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    expect(parseRetryAfterMs("not-a-date", now)).toBe(5 * 60_000);
    expect(parseRetryAfterMs("Mon, 01 Jun 2026 00:00:00 GMT", now)).toBe(5 * 60_000);
  });
});
