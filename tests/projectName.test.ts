import { describe, expect, it } from "vitest";
import { basenameAnySeparator } from "../src/shared/projectName";

describe("basenameAnySeparator", () => {
  it.each([
    ["  /home/alice/QuotaBar/  ", "QuotaBar"],
    ["C:\\Users/alice\\QuotaBar\\", "QuotaBar"],
    ["\\\\server\\share\\folder", "folder"],
  ])("returns a trimmed basename for %s", (value, expected) => {
    expect(basenameAnySeparator(value)).toBe(expected);
  });

  it.each([
    "", "   ", ".", "..", "/", "C:\\", "C:secret", "C:..", "\\\\server\\share", "bad\u0000name",
    "D--Work-Alice-QuotaBar", "C--src-private-QuotaBar", "-workspace-alice-QuotaBar",
  ])("rejects unsafe or root-only value %o", (value) => {
    expect(basenameAnySeparator(value)).toBeUndefined();
  });
});
