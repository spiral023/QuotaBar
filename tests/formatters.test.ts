import { describe, expect, it, vi } from "vitest";
import { formatTimeRemaining } from "../src/usage/formatters";

describe("formatTimeRemaining", () => {
  it("formats remaining time compactly", () => {
    vi.setSystemTime(new Date("2026-05-18T10:00:00.000Z"));

    expect(formatTimeRemaining("2026-05-18T10:00:00.000Z")).toBe("now");
    expect(formatTimeRemaining("2026-05-18T10:42:00.000Z")).toBe("42m");
    expect(formatTimeRemaining("2026-05-18T12:15:00.000Z")).toBe("2h15m");
    expect(formatTimeRemaining("2026-05-19T13:00:00.000Z")).toBe("1d3h");

    vi.useRealTimers();
  });
});
