import { describe, it, expect } from "vitest";
import { parseTagVersion, assertTagMatches } from "../src/build/versionTag";

describe("parseTagVersion", () => {
  it("strips a leading v", () => {
    expect(parseTagVersion("v1.2.3")).toBe("1.2.3");
  });
  it("accepts a bare version without v", () => {
    expect(parseTagVersion("1.2.3")).toBe("1.2.3");
  });
  it("accepts a prerelease suffix", () => {
    expect(parseTagVersion("v1.2.3-beta.1")).toBe("1.2.3-beta.1");
  });
  it("throws on a non-semver tag", () => {
    expect(() => parseTagVersion("v1.2")).toThrow();
    expect(() => parseTagVersion("release-1")).toThrow();
  });
});

describe("assertTagMatches", () => {
  it("passes when tag matches package version", () => {
    expect(() => assertTagMatches("v0.2.0", "0.2.0")).not.toThrow();
  });
  it("throws when tag and version differ", () => {
    expect(() => assertTagMatches("v0.2.0", "0.1.0")).toThrow(/0\.2\.0.*0\.1\.0/);
  });
});
