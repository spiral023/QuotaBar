import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const styles = () => fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "styles.css"), "utf8");

describe("plans layout", () => {
  it("stacks start and end date fields in compact view", () => {
    const css = styles();

    expect(css).toMatch(/\.view-compact\s+\.pl-f-grid\s*{[^}]*grid-template-columns:\s*1fr\b/s);
  });

  it("keeps the subscription dialog within narrow viewports", () => {
    const css = styles();

    expect(css).toMatch(/\.pl-dialog\s*{[^}]*max-width:\s*min\(340px,\s*calc\(100vw - 24px\)\)/s);
  });
});
