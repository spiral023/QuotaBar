import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("lint configuration", () => {
  it("exposes a lint npm script", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.lint).toBe("eslint .");
  });

  it("uses an ESLint flat config that ignores generated outputs", () => {
    const config = readFileSync("eslint.config.mjs", "utf8");

    expect(config).toContain("dist/**");
    expect(config).toContain("release/**");
    expect(config).toContain("package-output/**");
    expect(config).toContain("node_modules/**");
  });
});
