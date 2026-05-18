import { describe, expect, it } from "vitest";
import { getUsageColor, getUsageColorHex } from "../src/icon/colors";

describe("usage colors", () => {
  it("maps usage percent to status buckets", () => {
    expect(getUsageColor(49.9)).toBe("green");
    expect(getUsageColor(50)).toBe("yellow");
    expect(getUsageColor(75)).toBe("orange");
    expect(getUsageColor(90)).toBe("red");
  });

  it("uses the requested Windows tray color values", () => {
    expect(getUsageColorHex("green")).toBe("#52d017");
    expect(getUsageColorHex("yellow")).toBe("#ffd700");
    expect(getUsageColorHex("orange")).toBe("#ff8c00");
    expect(getUsageColorHex("red")).toBe("#ff4444");
  });
});
