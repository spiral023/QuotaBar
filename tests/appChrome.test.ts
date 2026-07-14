import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("app chrome renderer", () => {
  it("has a titlebar version placeholder beside the QuotaBar title", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "index.html"), "utf8");

    expect(html).toContain('class="logo-name">QuotaBar</span>');
    expect(html).toContain('id="titlebar-version"');
  });

  it("loads app metadata through IPC for the titlebar", () => {
    const script = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "app-shell.js"), "utf8");

    expect(script).toContain("app:meta");
    expect(script).toContain("titlebar-version");
  });

  it("keeps preparing analytics summaries out of the dashboard cache", () => {
    const script = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "app-shell.js"), "utf8");
    expect(script).toContain("QB.isPortableDataPreparing(s)");
    expect(script).toContain("Preparing data");
    expect(script).toMatch(/isPortableDataPreparing\(summary\)[\s\S]{0,220}analyticsSummaryCache\.delete\(costWindow\)/);
  });
});
