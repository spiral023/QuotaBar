import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..");

function cssRule(content: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? "";
}

describe("dashboard provider logos", () => {
  it("references the transparent provider logo assets", () => {
    const liveJs = fs.readFileSync(path.join(repoRoot, "src", "renderer", "tabs", "live.js"), "utf8");

    expect(liveJs).toContain("../../logos/claude.png");
    expect(liveJs).toContain("../../logos/codex.png");
  });

  it("includes the logo folder in packaged builds", () => {
    const builderConfig = fs.readFileSync(path.join(repoRoot, "electron-builder.yml"), "utf8");

    expect(builderConfig).toContain("logos/**");
  });

  it("keeps the Claude logo on a neutral background for contrast", () => {
    const css = fs.readFileSync(path.join(repoRoot, "src", "renderer", "styles.css"), "utf8");
    const claudeRule = cssRule(css, ".prov-icon.icon-claude");

    expect(claudeRule).toContain("rgba(255,255,255");
    expect(claudeRule).not.toContain("#e07818");
    expect(claudeRule).not.toContain("#b85a10");
  });
});
